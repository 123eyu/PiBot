import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ToolCall {
  /** Some compatible services reuse call IDs in different assistant turns. */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}
export interface Reply {
  text?: string;
  toolCalls?: ToolCall[];
  delayMs?: number;
  promptTokens?: number;
  reasoningTokens?: number;
  /** OpenAI includes reasoning in completion_tokens; Vertex reports it separately. */
  reasoningIncluded?: boolean;
  finishReason?: "stop" | "length" | "malformed_function_call";
  retryAfter?: string;
  httpError?: "context_length_exceeded" | "rate_limited" | "provider_error";
  /** Close the socket before headers, or after one nonempty SSE output without usage. */
  disconnect?: "before" | "after_output";
  /** Reliability fixtures: an idle pause, or an unfinished response until the client aborts. */
  pauseMs?: number;
  hang?: boolean;
}
export interface Scenario {
  replies: Reply[];
  /** Exact model IDs, deliberately unrelated to dynamically generated Bot UUIDs. */
  routes?: Record<string, Reply[]>;
}
export async function loadScenario(name: string): Promise<Scenario> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid scenario name.");
  const path = join(fileURLToPath(new URL("./scenarios", import.meta.url)), `${name}.json`);
  const raw = await readFile(path, "utf8");
  if (raw.length > 1024 * 1024) throw new Error("Scenario exceeds 1MB.");
  const value = JSON.parse(raw) as Scenario;
  if (!Array.isArray(value.replies) || !value.replies.length)
    throw new Error("Scenario needs nonempty replies.");
  if (value.routes && (typeof value.routes !== "object" || Array.isArray(value.routes)))
    throw new Error("routes must be an object.");
  for (const [model, replies] of Object.entries(value.routes ?? {})) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(model) || !Array.isArray(replies) || !replies.length)
      throw new Error("Invalid model route.");
  }
  for (const reply of [value.replies, ...Object.values(value.routes ?? {})].flat()) {
    if (!reply || (typeof reply.text !== "string" && !Array.isArray(reply.toolCalls)))
      throw new Error("Reply requires text or toolCalls.");
    if (reply.text && reply.text.length > 100000) throw new Error("Reply text too large.");
    if (
      reply.reasoningTokens !== undefined &&
      (!Number.isInteger(reply.reasoningTokens) ||
        reply.reasoningTokens < 0 ||
        reply.reasoningTokens > 1000000)
    )
      throw new Error("Invalid reasoningTokens.");
    if (reply.reasoningIncluded !== undefined && typeof reply.reasoningIncluded !== "boolean")
      throw new Error("Invalid reasoningIncluded.");
    if (
      reply.promptTokens !== undefined &&
      (!Number.isInteger(reply.promptTokens) ||
        reply.promptTokens < 0 ||
        reply.promptTokens > 1000000)
    )
      throw new Error("promptTokens must be 0..1000000.");
    if (
      reply.finishReason !== undefined &&
      !["stop", "length", "malformed_function_call"].includes(reply.finishReason)
    )
      throw new Error("Invalid finishReason.");
    if (
      reply.retryAfter !== undefined &&
      (typeof reply.retryAfter !== "string" ||
        reply.retryAfter.length > 128 ||
        /[\r\n]/.test(reply.retryAfter))
    )
      throw new Error("Invalid retryAfter.");
    if (reply.disconnect !== undefined && !["before", "after_output"].includes(reply.disconnect))
      throw new Error("Invalid disconnect.");
    if (
      reply.httpError !== undefined &&
      !["context_length_exceeded", "rate_limited", "provider_error"].includes(reply.httpError)
    )
      throw new Error("Invalid httpError.");
    if (
      reply.delayMs !== undefined &&
      (!Number.isInteger(reply.delayMs) || reply.delayMs < 0 || reply.delayMs > 10000)
    )
      throw new Error("delayMs must be 0..10000.");
    if (
      reply.pauseMs !== undefined &&
      (!Number.isInteger(reply.pauseMs) || reply.pauseMs < 0 || reply.pauseMs > 120000)
    )
      throw new Error("Invalid pauseMs.");
    if (reply.hang !== undefined && typeof reply.hang !== "boolean")
      throw new Error("Invalid hang.");
    if (reply.toolCalls) {
      if (!reply.toolCalls.length || reply.toolCalls.length > 16)
        throw new Error("Expected 1..16 tool calls.");
      for (const tool of reply.toolCalls)
        if (
          !tool ||
          !/^[a-zA-Z0-9_]+$/.test(tool.name) ||
          !tool.arguments ||
          typeof tool.arguments !== "object" ||
          Array.isArray(tool.arguments)
        )
          throw new Error("Invalid tool call.");
      for (const tool of reply.toolCalls)
        if (
          tool.id !== undefined &&
          (typeof tool.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(tool.id))
        )
          throw new Error("Invalid tool id.");
      for (const tool of reply.toolCalls)
        if (
          tool.thoughtSignature !== undefined &&
          (typeof tool.thoughtSignature !== "string" ||
            !tool.thoughtSignature.length ||
            tool.thoughtSignature.length > 65536)
        )
          throw new Error("Invalid thoughtSignature.");
    }
  }
  return value;
}
