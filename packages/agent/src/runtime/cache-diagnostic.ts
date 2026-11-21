import { createHash } from "node:crypto";
import type { CacheDiagnostic } from "../core/types.ts";
import { STATE_MARKER } from "../extensions/volatile-state.ts";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const kind = (item: unknown) =>
  isRecord(item)
    ? [item.type, item.role].filter((part) => typeof part === "string").join("/") || "?"
    : "?";
const TOOL_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output"]);
/** Pi Bot's own state item; only the opening of its first text block is inspected. */
const isState = (item: unknown) => {
  if (!isRecord(item)) return false;
  const first = Array.isArray(item.content) ? item.content[0] : item.content;
  const text = isRecord(first) ? first.text : first;
  return typeof text === "string" && text.startsWith(STATE_MARKER);
};

/**
 * GPT-5.6+ implicit-cache boundaries of a Responses payload (OpenAI prompt caching guide): user
 * messages, the last tool output of a consecutive run, and the last developer message of the
 * initial group. Other payload shapes report their user-message endings, the positions Anthropic
 * and Chat Completions callers normally cache at.
 */
function eligible(items: unknown[], responses: boolean) {
  let initial = 0;
  while (
    responses &&
    initial < items.length &&
    ["developer", "system"].includes(String((items[initial] as Json | undefined)?.role))
  )
    initial++;
  return items.map((item, i) => {
    if (!isRecord(item)) return false;
    if (item.role === "user") return true;
    if (!responses) return false;
    if (i === initial - 1) return true;
    const next = items[i + 1];
    return (
      TOOL_OUTPUTS.has(String(item.type)) &&
      !(isRecord(next) && TOOL_OUTPUTS.has(String(next.type)))
    );
  });
}

type Fingerprint = { header: string; items: string[]; requestedAt?: number; api?: string };

/**
 * The last request's fingerprint per session file, kept by the runtime across runs. Each run opens
 * a new session object, and without this the first request of a run had nothing to compare with,
 * which is exactly the cross-run cache question. Hashes only, bounded.
 */
export class CacheDiagnosticsMemory {
  private readonly last = new Map<string, Fingerprint>();
  get(key: string) {
    return this.last.get(key);
  }
  set(key: string, value: Fingerprint) {
    this.last.delete(key);
    this.last.set(key, value);
    if (this.last.size > 64) this.last.delete(this.last.keys().next().value as string);
  }
}

/**
 * Content-free description of every provider request of one session, for diagnosing prompt-cache
 * misses on the user's machine: payload shape, the role/type of the last items, short hashes of
 * the serialized prefix at each cache boundary, whether the request extends the previous one
 * item for item (what the Codex WebSocket continuation needs) and where it first differs. Only
 * hashes, counts and item types leave this class; never text.
 */
export class CacheDiagnostics {
  private previous?: Fingerprint;
  private pending?: CacheDiagnostic;
  private websocket?: { requests: number; deltaRequests: number; sseFallbacks: number };
  private crossRun: boolean;

  constructor(private readonly memory?: { store: CacheDiagnosticsMemory; key: string }) {
    this.previous = memory?.store.get(memory.key);
    this.crossRun = !!this.previous;
  }

  /** Called with the final payload (after every extension hook), before it is sent. */
  request(payload: unknown, api: string, transport: string | undefined) {
    if (!isRecord(payload)) return;
    const responses = Array.isArray(payload.input);
    const items: unknown[] = (responses ? payload.input : payload.messages) as unknown[];
    if (!Array.isArray(items)) return;
    const header = short(
      JSON.stringify([payload.instructions ?? payload.system ?? "", payload.tools ?? []]),
    );
    const serialized = items.map((item) => JSON.stringify(item));
    const itemHashes = serialized.map(short);
    const flags = eligible(items, responses);
    const hash = createHash("sha256").update(header);
    const boundaries: string[] = [];
    serialized.forEach((text, i) => {
      hash.update(text);
      if (flags[i]) boundaries.push(`${i}:${hash.copy().digest("hex").slice(0, 12)}`);
    });
    const previous = this.previous;
    let firstChange: number | undefined;
    if (previous) {
      const limit = Math.min(previous.items.length, itemHashes.length);
      firstChange = 0;
      while (firstChange < limit && previous.items[firstChange] === itemHashes[firstChange])
        firstChange++;
    }
    const requestedAt = Date.now();
    this.previous = { header, items: itemHashes, requestedAt, api };
    this.memory?.store.set(this.memory.key, this.previous);
    const crossRun = this.crossRun;
    this.crossRun = false;
    this.pending = {
      api,
      requestedAt,
      ...(previous?.requestedAt !== undefined && previous.api === api
        ? { intervalMs: Math.max(0, requestedAt - previous.requestedAt) }
        : {}),
      transport: transport ?? "auto",
      ...(typeof payload.prompt_cache_key === "string"
        ? { cacheKey: short(payload.prompt_cache_key) }
        : {}),
      items: items.length,
      tail: items.slice(-3).map(kind),
      states: items.flatMap((item, i) => (isState(item) ? [i] : [])),
      boundaries: boundaries.slice(-8),
      ...(previous
        ? {
            ...(crossRun ? { sincePreviousRun: true } : {}),
            headerChanged: previous.header !== header,
            extendsPrevious: previous.header === header && firstChange === previous.items.length,
            firstChange: `${firstChange}:${firstChange !== undefined ? kind(items[firstChange]) : ""}`,
          }
        : {}),
    };
  }

  /**
   * Completes the line with the usage the provider reported. For the ChatGPT (Codex) adapter it
   * also reports whether the request went over the WebSocket and whether pi sent it as a
   * `previous_response_id` continuation, from pi-ai's own per-session counters.
   */
  async settle(
    usage: { input: number; cacheRead: number; cacheWrite: number } | undefined,
    api: string,
    sessionId: string | undefined,
  ): Promise<CacheDiagnostic | undefined> {
    const line = this.pending;
    this.pending = undefined;
    if (!line) return;
    if (usage)
      Object.assign(line, {
        input: usage.input,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      });
    if (api === "openai-codex-responses" && sessionId) {
      const { getOpenAICodexWebSocketDebugStats } = await import(
        "@earendil-works/pi-ai/api/openai-codex-responses"
      );
      const stats = getOpenAICodexWebSocketDebugStats(sessionId);
      const before = this.websocket ?? { requests: 0, deltaRequests: 0, sseFallbacks: 0 };
      if (stats) {
        line.wire =
          stats.sseFallbacks > before.sseFallbacks
            ? "sse-fallback"
            : stats.requests > before.requests
              ? stats.deltaRequests > before.deltaRequests
                ? "websocket-continuation"
                : "websocket-full"
              : "sse";
        this.websocket = {
          requests: stats.requests,
          deltaRequests: stats.deltaRequests,
          sseFallbacks: stats.sseFallbacks,
        };
      } else line.wire = "sse";
    }
    return line;
  }
}
