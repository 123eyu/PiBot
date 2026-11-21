import type {
  Api,
  AssistantMessage,
  Model,
  Provider,
  StreamFunction,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { z } from "zod";
import { AgentError, agentHttpStatus, mapAgentError } from "../core/errors.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Distinguish Google replay data from pi's legacy encrypted-reasoning tool signatures.
const SIGNATURE_PREFIX = "pibot-google-thought:";
const signatureSchema = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => Buffer.byteLength(value) <= 65_536);
const usageSchema = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  total_tokens: count.optional(),
  reasoning_tokens: count.optional(),
  completion_tokens_details: z.object({ reasoning_tokens: count.nullish() }).nullish(),
});
const chunkSchema = z.object({
  usage: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int().optional(),
        usage: z.unknown().optional(),
        delta: z
          .object({
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative().optional(),
                  id: z.string().max(1024).nullish(),
                  extra_content: z
                    .object({
                      google: z.object({ thought_signature: signatureSchema.nullish() }).nullish(),
                    })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});

class GoogleCompletionsState {
  constructor(
    private readonly model: Model<Api>,
    private readonly context: TranscriptContext,
  ) {}
  private readonly signatures = new Map<string, string>();
  private readonly indexes = new Map<number, { id?: string; signature?: string }>();
  private signatureBytes = 0;
  private rawUsage: z.infer<typeof usageSchema> | undefined;
  remember(data: unknown) {
    const parsed = chunkSchema.safeParse(data);
    if (!parsed.success) return;
    const choice = parsed.data.choices?.[0];
    const usage = usageSchema.safeParse(parsed.data.usage ?? choice?.usage);
    if (usage.success) this.rawUsage = usage.data;
    for (const call of choice?.delta?.tool_calls ?? []) {
      const key = call.index ?? 0;
      const previous = this.indexes.get(key) ?? {};
      const signature = call.extra_content?.google?.thought_signature ?? previous.signature;
      const id = call.id ?? previous.id;
      this.signatureBytes += Buffer.byteLength(call.extra_content?.google?.thought_signature ?? "");
      const overflow = this.indexes.size >= 128 && !this.indexes.has(key);
      // Providers without Google metadata retain their existing tool-call behavior.
      if (overflow && !signature) continue;
      if (
        overflow ||
        this.signatureBytes > 1_048_576 ||
        (signature && previous.id && call.id && previous.id !== call.id)
      )
        throw new AgentError("provider_error");
      this.indexes.set(key, { id, signature });
      if (id && signature) this.signatures.set(id, signature);
    }
  }
  decorate(message: AssistantMessage, final = false) {
    const model = this.model;
    for (const part of message.content)
      if (part.type === "toolCall" && this.signatures.has(part.id))
        part.thoughtSignature = SIGNATURE_PREFIX + this.signatures.get(part.id);
    if (!final || !this.rawUsage) return;
    const reasoning =
      this.rawUsage.completion_tokens_details?.reasoning_tokens ??
      this.rawUsage.reasoning_tokens ??
      0;
    // A total covering prompt + visible output + reasoning proves separate accounting.
    // Standard OpenAI/OpenRouter totals already include reasoning: never add it twice.
    const separate =
      this.rawUsage.total_tokens !== undefined &&
      reasoning > 0 &&
      this.rawUsage.total_tokens ===
        this.rawUsage.prompt_tokens + this.rawUsage.completion_tokens + reasoning;
    if (!separate) return;
    message.usage.output = this.rawUsage.completion_tokens + reasoning;
    message.usage.reasoning = reasoning;
    message.usage.totalTokens =
      message.usage.input +
      message.usage.output +
      message.usage.cacheRead +
      message.usage.cacheWrite;
    calculateCost(model, message.usage);
  }
  replay(payload: unknown) {
    const { model, context } = this;
    if (!payload || typeof payload !== "object") return payload;
    const messages = Reflect.get(payload, "messages");
    if (!Array.isArray(messages)) return payload;
    // pi preserves successful assistant tool-message order, but IDs can repeat across turns.
    // Match the original message and exact call, never a global last-signature-by-ID map.
    const originals = context.messages.filter(
      (message): message is AssistantMessage =>
        message.role === "assistant" &&
        message.stopReason !== "error" &&
        message.stopReason !== "aborted" &&
        message.content.some((part) => part.type === "toolCall"),
    );
    let position = 0;
    for (const message of messages) {
      if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
      const original = originals[position++];
      if (
        !original ||
        original.api !== model.api ||
        original.provider !== model.provider ||
        original.model !== model.id
      )
        continue;
      const calls = original.content.filter((part) => part.type === "toolCall");
      for (const [index, call] of message.tool_calls.entries()) {
        const stored = calls[index];
        if (
          stored?.thoughtSignature?.startsWith(SIGNATURE_PREFIX) &&
          call.id === stored.id &&
          call.function?.name === stored.name &&
          call.function?.arguments === JSON.stringify(stored.arguments)
        )
          call.extra_content = {
            ...call.extra_content,
            google: {
              ...call.extra_content?.google,
              thought_signature: stored.thoughtSignature.slice(SIGNATURE_PREFIX.length),
            },
          };
      }
    }
    return payload;
  }
}

/** Pi's OpenAI converter drops Google tool signatures and assumes inclusive output usage.
 * Keep the adaptation at the provider boundary, before the run's accounting sees the result.
 */
export function openaiGoogle(provider: Provider): Provider {
  const wrap = <T extends Provider["stream"] | Provider["streamSimple"]>(source: T): T => {
    const invoke = source as StreamFunction;
    const stream: StreamFunction = (model, context, options) => {
      if (model.api !== "openai-completions") return invoke(model, context, options);
      const state = new GoogleCompletionsState(model, context);
      const result = createAssistantMessageEventStream();
      const input = invoke(model, context, {
        ...options,
        onPayload: async (payload, selected) => {
          const next = state.replay(payload);
          return state.replay((await options?.onPayload?.(next, selected)) ?? next);
        },
        onProviderStreamEvent: async (data, selected) => {
          state.remember(data);
          await options?.onProviderStreamEvent?.(data, selected);
        },
      });
      void (async () => {
        let last: AssistantMessage | undefined;
        try {
          for await (const event of input) {
            last =
              event.type === "done"
                ? event.message
                : event.type === "error"
                  ? event.error
                  : event.partial;
            if (event.type === "done") state.decorate(event.message, true);
            else if (event.type === "error") state.decorate(event.error, true);
            else state.decorate(event.partial);
            result.push(event);
          }
          const message = await input.result();
          state.decorate(message, true);
          result.end(message);
        } catch (error) {
          // Always settle the outer stream, preserving partial usage without raw SDK diagnostics.
          const code = options?.signal?.aborted ? "aborted" : mapAgentError(error);
          const status = agentHttpStatus(error);
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            content: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            ...last,
            stopReason: code === "aborted" ? "aborted" : "error",
            errorMessage: `${code === "internal" ? "provider_error" : code}${status ? ` HTTP ${status}` : ""}`,
          };
          state.decorate(message, true);
          result.push({
            type: "error",
            reason: message.stopReason === "aborted" ? "aborted" : "error",
            error: message,
          });
          result.end();
        }
      })();
      return result;
    };
    return stream as T;
  };
  return {
    ...provider,
    stream: wrap(provider.stream),
    streamSimple: wrap(provider.streamSimple),
  };
}
