// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: host temp directories, global caches and environment switches removed; files and redaction go through Pi Bot ports.
// Upstream file: utils.ts
// Cut: JSONC parsing (brain-side import contract owns manifest parsing), TUI/CLI entry
// helpers, OS open/exec helpers, `!command` secret execution and `${ENV}` interpolation
// (Pi Bot resolves secrets via SecretStore and never inherits the host environment),
// bearer/OAuth token resolution, TUI status formatting, UI stream mode extraction.
import type { McpToolAnnotations } from "./types.ts";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const iterator = items.entries();

  async function worker() {
    while (true) {
      const next = iterator.next();
      if (next.done) return;
      const [index, item] = next.value;
      results[index] = await fn(item);
    }
  }

  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);
  return results;
}

export function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Remove OSC control strings, including payloads that have no terminator. */
export function stripOscSequences(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const isEscOsc = text.charCodeAt(index) === 0x1b && text[index + 1] === "]";
    const isC1Osc = text.charCodeAt(index) === 0x9d;
    if (!isEscOsc && !isC1Osc) {
      result += text[index++];
      continue;
    }

    index += isEscOsc ? 2 : 1;
    while (index < text.length) {
      const code = text.charCodeAt(index++);
      if (code === 0x07 || code === 0x9c) break;
      if (code === 0x1b && text[index] === "\\") {
        index++;
        break;
      }
    }
  }
  return result;
}

export function sanitizeTerminalText(text: string): string {
  return (
    stripOscSequences(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes and control characters is the purpose here.
      .replace(/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function formatTerminalError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const collect = (value: unknown) => {
    if (seen.has(value)) return;
    if ((typeof value === "object" && value !== null) || typeof value === "function")
      seen.add(value);

    if (value instanceof AggregateError) {
      const countBefore = messages.length;
      for (const nested of value.errors) collect(nested);
      if (value.cause !== undefined) collect(value.cause);
      if (messages.length === countBefore && value.message) messages.push(value.message);
      return;
    }
    if (value instanceof Error) {
      if (value.message) messages.push(value.message);
      if (value.cause !== undefined) collect(value.cause);
      return;
    }
    messages.push(String(value));
  };

  collect(error);
  return sanitizeTerminalText([...new Set(messages)].join(": "));
}

export function truncateAtWord(text: string, target: number): string {
  if (!text || text.length <= target) return text;

  const truncated = text.slice(0, target);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > target * 0.6) {
    return `${truncated.slice(0, lastSpace)}...`;
  }

  return `${truncated}...`;
}

/** Request `_meta` key that lets MCP servers correlate a call with the Pi tool call that made it. */
export const TOOL_CALL_ID_REQUEST_META_KEY = "pi-mcp-adapter/toolCallId";

export function withToolCallIdMeta(
  meta: Record<string, unknown> | undefined,
  toolCallId: string | undefined,
): Record<string, unknown> | undefined {
  if (!toolCallId) return meta;
  return { ...meta, [TOOL_CALL_ID_REQUEST_META_KEY]: toolCallId };
}

export function normalizeDirectToolInputSchema(schema: unknown): Record<string, unknown> {
  const inputSchema =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : { type: "object", properties: {} };
  const { $schema, additionalProperties, ...normalized } = inputSchema;
  return normalized;
}

export function normalizeToolArguments(
  value: unknown,
  context = "tool arguments",
): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `${context}: invalid args JSON (${error instanceof SyntaxError ? error.message : String(error)}); ` +
          `pass args as a JSON object, or as a valid JSON string encoding one`,
        { cause: error },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `${context}: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${context}: expected a JSON object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
  }

  assertJsonSerializable(value, context);
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${context}: value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertJsonSerializable(value: unknown, context: string, path = ""): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${context}: value at ${path || "root"} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      assertJsonSerializable(item, context, `${path}[${index}]`);
    return;
  }
  if (typeof value === "object") {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error(`${context}: value at ${path || "root"} is not a plain JSON object`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${context}: value at ${path || "root"} has symbol keys`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSerializable(item, context, path ? `${path}.${key}` : key);
    }
    return;
  }
  throw new Error(`${context}: value at ${path || "root"} is not JSON-serializable`);
}

/**
 * Keep only the spec tool annotations with the right types. Server and cache
 * input is untrusted, so a malformed field is dropped instead of failing the tool list.
 */
export function extractToolAnnotations(annotations: unknown): McpToolAnnotations | undefined {
  if (!annotations || typeof annotations !== "object") return undefined;
  const source = annotations as Record<string, unknown>;
  const kept: McpToolAnnotations = {};
  if (typeof source.title === "string") kept.title = source.title;
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof source[key] === "boolean") kept[key] = source[key];
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}
