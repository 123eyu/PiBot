import { readFile } from "node:fs/promises";
import { projectToolHistory } from "../../../packages/agent/src/extensions/tool-loadout.ts";
import { trimOlderToolResults } from "../../../packages/agent/src/extensions/tool-result-trim.ts";
import {
  placeSystemMessages,
  REFERENCE_MARKER,
  STATE_MARKER,
  stateAsDeveloperMessage,
} from "../../../packages/agent/src/extensions/volatile-state.ts";
import {
  type CacheRule,
  firstDifference,
  responsesSections,
  type Section,
  simulateImplicitCache,
} from "./breakpoints.ts";

type Json = Record<string, unknown>;

// tools/ has no pi dependency of its own; use the exact locked copy the agent package runs.
const piAi = new URL(
  "../../../packages/agent/node_modules/@earendil-works/pi-ai/dist/",
  import.meta.url,
);

/** A JWT-shaped placeholder: the Codex adapter only reads the account claim, nothing is sent. */
const fakeToken = [
  "e30",
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "replay" } }),
  ).toString("base64url"),
  "x",
].join(".");

/** Runs pi-ai's real ChatGPT (Codex) request builder and stops before any network use. */
async function codexBody(model: Json, messages: unknown[], sessionId: string): Promise<Json> {
  const { stream } = await import(new URL("api/openai-codex-responses.js", piAi).href);
  let captured: Json | undefined;
  const events = stream(
    model as never,
    { messages } as never,
    {
      apiKey: fakeToken,
      sessionId,
      transport: "sse",
      onPayload: (body: unknown) => {
        captured = body as Json;
        throw new Error("replay stops before sending");
      },
      fetch: () => Promise.reject(new Error("replay never sends")),
    } as never,
  );
  // pi-ai reports the stop as an error event; only the payload matters here.
  for await (const _event of events as AsyncIterable<unknown>);
  if (!captured) throw new Error("payload hook did not run");
  return captured;
}

const text = (value: string, role = "user") => ({
  role,
  content: [{ type: "text", text: value }],
  timestamp: 0,
});
const chars = (sections: Section[]) => sections.reduce((sum, part) => sum + part.text.length, 0);

/** Least-squares fit of tokens = a * chars + b; the reference size is b / a characters. */
function fitReference(points: { chars: number; tokens: number }[]) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.chars, 0) / n;
  const my = points.reduce((s, p) => s + p.tokens, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.chars - mx) ** 2, 0);
  const a = sxx ? points.reduce((s, p) => s + (p.chars - mx) * (p.tokens - my), 0) / sxx : 0;
  const b = my - a * mx;
  return { a, b: Math.round(b), chars: a > 0 ? Math.max(0, Math.round(b / a)) : 0 };
}

interface Request {
  history: Json[];
  model: Json;
  usage: Json;
  users: number;
}

/**
 * Offline replay of a real session file through Pi Bot's request-side trimming, pi-ai's real
 * Codex builder and Pi Bot's payload hook. Prints structure and numbers only (positions, item
 * types, recorded usage), never content.
 *
 * The group reference is not stored in the session file, so `group` adds a synthetic one of the
 * size the recorded usage implies (linear fit of recorded tokens against replayed characters).
 * Before = everything in one trailing user message (what group runs once sent: the
 * untrusted reference kept the state a user message). Trailing state = the reference right after
 * the run's starting message (identical within a run), the trusted state trailing as a developer
 * message. Without `group` the two columns differ only in where the state sits. Append-only = the
 * run's state pinned right after the starting message (and reference), never re-sent at the end,
 * with pi's system messages merged into the leading one (what every Pi Bot hook once did).
 * Persisted = earlier runs' states and references stay in place, a new run adds its own
 * state (pessimistic: one per run) and, in groups, an update of a tenth of the reference size;
 * tool declarations stay in place (`placeSystemMessages`) with the history made additive
 * (`projectToolHistory`, visible = the tools declared at that request).
 * `rule` picks the simulated cache rule (`breakpoints.ts::CacheRule`); `trailing` is what the
 * ChatGPT (Codex) backend did on the owner's machine.
 * Usage: node tests/e2e/cache/index.ts --replay <session.jsonl> [--group[=<chars>]] [--rule=guide|trailing]
 */
export async function replaySession(
  file: string,
  group: false | "fit" | number = false,
  rule: CacheRule = "trailing",
  contextWindow = 272_000,
) {
  const models = JSON.parse(
    await readFile(new URL("providers/data/openai-codex.json", piAi), "utf8"),
  ) as Record<string, Record<string, Json>>;
  const entries = (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);
  const sessionId = String(entries[0]?.id ?? "replay");
  const history: Json[] = [];
  const requests: Request[] = [];
  for (const entry of entries) {
    const message = entry.message as Json | undefined;
    if (entry.type !== "message" || !message) continue;
    const model =
      message.role === "assistant" && message.usage && message.api === "openai-codex-responses"
        ? Object.values(models)
            .flatMap((entries) => Object.values(entries))
            .find((candidate) => candidate.id === message.model)
        : undefined;
    if (model)
      requests.push({
        // A snapshot: `history` keeps growing after this request.
        history: (trimOlderToolResults(history as never, contextWindow) ??
          history.slice()) as Json[],
        model,
        usage: message.usage as Json,
        users: history.filter((m) => m.role === "user").length,
      });
    history.push(message);
  }
  const tokensOf = (request: Request) =>
    Number(request.usage.input ?? 0) + Number(request.usage.cacheRead ?? 0);
  let referenceChars = typeof group === "number" ? group : 0;
  const notes: string[] = referenceChars
    ? [`synthetic group reference: ${referenceChars} chars (given)`]
    : [];
  if (group === "fit") {
    const points = [];
    for (const request of requests) {
      const body = await codexBody(
        request.model,
        [...request.history, text(`${STATE_MARKER}: replay]`)],
        sessionId,
      );
      points.push({ chars: chars(responsesSections(body)), tokens: tokensOf(request) });
    }
    const fit = fitReference(points);
    referenceChars = fit.chars;
    notes.push(
      `synthetic group reference: ${referenceChars} chars, fitted from recorded usage (tokens = ${fit.a.toFixed(3)} x chars ${fit.b < 0 ? "-" : "+"} ${Math.abs(fit.b)}; a non-positive intercept means the session file already explains the recorded size)`,
    );
  }
  const before: Section[][] = [];
  const after: Section[][] = [];
  const pinned: Section[][] = [];
  const persisted: Section[][] = [];
  const append = { api: "openai-codex-responses" };
  const updateChars = Math.round(referenceChars / 10);
  for (const request of requests) {
    // Distinct per run: a new run rebuilds the reference from newer group data.
    const reference = referenceChars
      ? `${REFERENCE_MARKER}, untrusted: run ${request.users}]\n${"群参考 reference line. ".repeat(Math.ceil(referenceChars / 22)).slice(0, referenceChars)}`
      : "";
    const state = `${STATE_MARKER} #1: replay]`;
    const states = new Set([state]);
    const oldBody = await codexBody(
      request.model,
      [
        ...request.history,
        // Originally the reference rode in the state message, which kept it a user message.
        text(reference ? `${state}\n\nUntrusted group reference:\n${reference}` : state),
      ],
      sessionId,
    );
    before.push(responsesSections(oldBody));
    const start = request.history.findLastIndex((m) => m.role === "user");
    const opening = [
      ...request.history.slice(0, start + 1),
      ...(reference ? [text(reference)] : []),
    ];
    const promoted = async (messages: unknown[]) => {
      const body = await codexBody(request.model, messages, sessionId);
      return responsesSections(
        (stateAsDeveloperMessage(body, request.model as never, states) ?? body) as Json,
      );
    };
    after.push(await promoted([...opening, ...request.history.slice(start + 1), text(state)]));
    pinned.push(
      await promoted(
        placeSystemMessages(
          [...opening, text(state), ...request.history.slice(start + 1)] as { role: string }[],
          {},
        ),
      ),
    );
    // Every run's state (and group reference or update) sits after its starting message.
    const runStates = new Set<string>();
    let run = 0;
    const withRuns = request.history.flatMap((message) => {
      if (message.role !== "user") return [message];
      run++;
      const own = `${STATE_MARKER} #${run}: replay]`;
      runStates.add(own);
      const size = run === 1 ? referenceChars : updateChars;
      const ref = size
        ? [
            text(
              `${REFERENCE_MARKER}, untrusted: run ${run}]\n${"群参考 reference line. ".repeat(Math.ceil(size / 22)).slice(0, size)}`,
            ),
          ]
        : [];
      return [message, ...ref, text(own)];
    });
    const visible = new Set(
      (request.history as { role: string; toolsAdded?: { name: string }[] }[])
        .filter((m) => m.role === "system")
        .flatMap((m) => m.toolsAdded ?? [])
        .map((tool) => tool.name),
    );
    const placed = placeSystemMessages(projectToolHistory(withRuns as never, visible), append);
    const body = await codexBody(request.model, placed as unknown[], sessionId);
    persisted.push(
      responsesSections(
        (stateAsDeveloperMessage(body, request.model as never, runStates) ?? body) as Json,
      ),
    );
  }
  const sim = [before, after, pinned, persisted].map((layout) =>
    simulateImplicitCache(layout, rule),
  );
  const out = [
    ...notes,
    `cache rule: ${rule}`,
    ...(updateChars ? [`synthetic group update per later run: ${updateChars} chars`] : []),
    "#  run   recorded(in/cacheRead)  simulated uncached before -> trailing-state -> append-only -> persisted (tokens, scaled from chars)  prefix vs previous",
  ];
  const sums = { recordedRead: 0, cached: [0, 0, 0, 0], total: 0 };
  for (const [i, row] of requests.entries()) {
    const input = Number(row.usage.input ?? 0);
    const read = Number(row.usage.cacheRead ?? 0);
    const tokens = input + read;
    // Recorded tokens include the real reference, which the synthetic one stands in for.
    // Each layout against its own size (persisted carries more state items than the others).
    const cached = sim.map((rows) => {
      const row = rows[i];
      return row?.total ? Math.round((row.cached / row.total) * tokens) : 0;
    });
    sums.recordedRead += read;
    cached.forEach((value, k) => {
      sums.cached[k] = (sums.cached[k] ?? 0) + value;
    });
    sums.total += tokens;
    const previous = requests[i - 1];
    const diff = i ? firstDifference(persisted[i - 1] ?? [], persisted[i] ?? []) : undefined;
    out.push(
      `${String(i).padStart(2)} ${!previous || previous.users !== row.users ? "new " : "same"}  ${String(input).padStart(6)}/${String(read).padStart(6)}  ${cached.map((value) => String(tokens - value).padStart(7)).join(" -> ")}` +
        (diff ? `  ${(diff.prefix * 100).toFixed(1)}% ${diff.at}` : ""),
    );
  }
  const total = sums.total;
  const share = (value: number) => `${value} (${((value / total) * 100).toFixed(1)}%)`;
  out.push(
    `total input tokens ${total}: recorded cacheRead ${share(sums.recordedRead)}, simulated cached before ${share(sums.cached[0] ?? 0)}, trailing-state ${share(sums.cached[1] ?? 0)}, append-only ${share(sums.cached[2] ?? 0)}, persisted ${share(sums.cached[3] ?? 0)}; ` +
      `uncached ${sums.cached.map((value) => total - value).join(" -> ")}`,
  );
  return out.join("\n");
}
