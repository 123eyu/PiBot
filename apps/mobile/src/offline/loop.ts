import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  PortableApi,
  StreamOptions,
  Tool,
  ToolCall,
} from "@pibot/agent/portable";
import type { OfflineSnapshot, OfflineUsage, UserQuestion } from "@pibot/protocol";
import type { LocalMessage } from "./store.ts";
import type { ToolOutcome } from "./tools.ts";

export type Stream = (
  model: Model<PortableApi>,
  context: Context,
  options: StreamOptions,
) => AssistantMessageEventStream;
/** A reply on the phone stays short: a few tool rounds, never an unattended task. */
export const OFFLINE_LIMITS = { modelCalls: 8, toolCalls: 12, ms: 180_000, history: 30 };
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface ReplyInput {
  model: Model<PortableApi>;
  apiKey: string;
  /** Provider's custom request headers, delivered with the key. */
  headers?: Record<string, string>;
  snapshot: OfflineSnapshot;
  /** The topic so far, the new user message last. */
  history: readonly LocalMessage[];
  /** Tool names this phone can run (the snapshot's, minus what this device lacks). */
  tools: readonly string[];
  canContinue?: () => boolean;
  run(name: string, args: unknown, signal: AbortSignal): Promise<ToolOutcome>;
  signal: AbortSignal;
  stream: Stream;
  /** The reply text so far, for streaming display. */
  /** The words of the model reply being streamed now. */
  onText(text: string): void;
  /** A model reply's words are complete and tool calls follow; it becomes its own message. */
  onPart?(text: string): void;
  /** Each model request leaves the phone: the privacy ledger counts them (no content). */
  onRequest(messageCount: number): void;
  now?: () => number;
}
export interface ReplyResult {
  status: "done" | "error" | "aborted";
  text: string;
  errorCode?: string;
  usage: OfflineUsage;
  tools: { name: string; outcome: string }[];
  question?: UserQuestion;
  /** Each model reply's words with the tool steps that followed it, in order. */
  parts?: { text: string; tools: { name: string; outcome: string }[] }[];
}
/** The model-side transcript. The curated memory rides in front of the first user message,
 *  as reference text (never the system prompt), the way the desktop places its reference. */
function transcript(input: ReplyInput): Message[] {
  const recent = input.history.slice(-OFFLINE_LIMITS.history);
  let referenced = !input.snapshot.reference;
  return recent.flatMap((message): Message[] => {
    const at = Date.parse(message.createdAt);
    if (message.role === "user") {
      const text = message.content || " ";
      const content = referenced
        ? text
        : [
            { type: "text" as const, text: input.snapshot.reference },
            { type: "text" as const, text },
          ];
      referenced = true;
      return [{ role: "user", content, timestamp: at }];
    }
    if (!message.content.trim()) return [];
    return [
      {
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: input.model.api,
        provider: input.model.provider,
        model: input.model.id,
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: at,
      },
    ];
  });
}
/** Our fixed codes from what pi-ai reports; the vendor's own message never reaches the screen. */
function errorCode(message: AssistantMessage) {
  const text = (message.errorMessage ?? "").toLowerCase();
  if (/\b(401|403)\b|unauthor|invalid api key|authentication/.test(text)) return "auth_failed";
  if (/\b429\b|rate limit/.test(text)) return "rate_limited";
  if (/fetch|network|econn|timed? ?out|socket/.test(text)) return "network";
  if (/context|too long|maximum context/.test(text)) return "context_overflow";
  return "provider_error";
}

/**
 * One offline reply. A small loop — model → tool calls → policy → phone capability →
 * model — bounded in model calls, tool calls and time, cancelled by `signal`. The states match
 * the desktop's: streaming, then done / error / aborted.
 */
export async function runOfflineReply(input: ReplyInput): Promise<ReplyResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const deadline = AbortSignal.any([input.signal, AbortSignal.timeout(OFFLINE_LIMITS.ms)]);
  const tools: Tool[] = input.snapshot.tools
    .filter((tool) => input.tools.includes(tool.name))
    .map((tool) => tool as unknown as Tool);
  const context: Context = {
    systemPrompt: input.snapshot.systemPrompt,
    messages: transcript(input),
    ...(tools.length ? { tools } : {}),
  };
  const usage: OfflineUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    requests: 0,
  };
  const records: ReplyResult["tools"] = [];
  const texts: string[] = [];
  const parts: NonNullable<ReplyResult["parts"]> = [];
  let question: UserQuestion | undefined;
  let toolCalls = 0;
  const finish = (status: ReplyResult["status"], code?: string): ReplyResult => ({
    status,
    text: texts.join("\n\n").trim(),
    ...(code ? { errorCode: code } : {}),
    usage,
    tools: records,
    ...(question ? { question } : {}),
    ...(parts.length ? { parts } : {}),
  });
  for (let call = 0; call < OFFLINE_LIMITS.modelCalls; call++) {
    if (input.signal.aborted) return finish("aborted");
    if (deadline.aborted || now() - started > OFFLINE_LIMITS.ms)
      return finish("error", "budget_exhausted");
    if (input.canContinue && !input.canContinue()) return finish("done");
    input.onRequest(context.messages.length);
    usage.requests++;
    let current = "";
    let final: AssistantMessage | undefined;
    for await (const event of input.stream(input.model, context, {
      apiKey: input.apiKey,
      ...(input.headers ? { headers: input.headers } : {}),
      signal: deadline,
      maxTokens: Math.min(input.model.maxTokens, 8192),
      maxRetries: 1,
      timeoutMs: 90_000,
    })) {
      if (event.type === "text_delta") {
        current += event.delta;
        input.onText(current.trim());
      }
      if (event.type === "done") final = event.message;
      if (event.type === "error") final = event.error;
    }
    if (!final) return finish("error", "provider_error");
    usage.input += final.usage.input;
    usage.output += final.usage.output;
    usage.cacheRead += final.usage.cacheRead;
    usage.cacheWrite += final.usage.cacheWrite;
    usage.totalTokens += final.usage.totalTokens;
    usage.costUsd += Math.max(0, final.usage.cost.total);
    const text = final.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    if (text.trim()) {
      texts.push(text.trim());
      parts.push({ text: text.trim(), tools: [] });
    }
    if (final.stopReason === "aborted")
      return finish(
        input.signal.aborted ? "aborted" : "error",
        input.signal.aborted ? undefined : "budget_exhausted",
      );
    if (final.stopReason === "error") return finish("error", errorCode(final));
    const calls = final.content.filter((part): part is ToolCall => part.type === "toolCall");
    if (!calls.length) return finish("done");
    if (text.trim()) input.onPart?.(text.trim());
    context.messages.push(final);
    for (const tool of calls) {
      if (input.canContinue && !input.canContinue()) return finish("done");
      toolCalls++;
      const outcome: ToolOutcome =
        toolCalls > OFFLINE_LIMITS.toolCalls
          ? {
              text: "本次回复的工具调用次数已达上限 / Tool call limit for this reply reached",
              isError: true,
              record: { name: tool.name.slice(0, 80), outcome: "tool_limit" },
            }
          : await input.run(tool.name, tool.arguments, deadline);
      if (records.length < 20) {
        records.push(outcome.record);
        // A text-less reply's tool steps stay with the words that announced them.
        const part = parts.at(-1) ?? parts[parts.push({ text: "", tools: [] }) - 1];
        part?.tools.push(outcome.record);
      }
      if (outcome.question && !question) question = outcome.question;
      context.messages.push({
        role: "toolResult",
        toolCallId: tool.id,
        toolName: tool.name,
        content: [{ type: "text", text: outcome.text }, ...(outcome.images ?? [])],
        isError: outcome.isError,
        timestamp: now(),
      });
    }
  }
  return finish("error", "repeated_operation");
}
