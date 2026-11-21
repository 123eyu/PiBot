import type { Api, Model, Provider, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { mapAgentError } from "../core/errors.ts";

// The plan's usage limit as pi's Codex route reports it (its friendly message, or the raw codes
// when the body could not be parsed).
const USAGE_LIMIT =
  /ChatGPT usage limit|\b(?:usage_limit_reached|usage_not_included|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded)\b/;
/** The fixed message a refused plan request carries instead of pi's API-key wording. */
export const CHATGPT_PLAN_DENIED = "chatgpt_plan_denied";
/**
 * OpenAI's eligibility refusal (developers.openai.com/siwc errors and recovery: explain it, do not
 * retry or loop through sign-in), kept apart from an expired sign-in.
 */
export const CHATGPT_PLAN_NOT_ELIGIBLE = "chatgpt_plan_not_eligible";
const NOT_ELIGIBLE = /\bsubscription_sharing_user_not_eligible\b/;

type Stream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: StreamOptions,
) => AssistantMessageEventStream;

/**
 * The ChatGPT plan provider: this wrapper owns chat requests. Image generation is
 * attached separately by the image catalog through OpenAI's Responses image_generation tool;
 * no SDK retries (a usage-limit or eligibility error does not clear by
 * retrying), the usage-limit state reported to the app, and a refused request (401/403) reported
 * as the plan's own failure, never as a bad API key. Request bodies are pi's Codex route's own.
 */
/**
 * OpenAI's own error text for a refused plan request ("403 {detail}", an error code), so the log
 * says why instead of a bare provider_error. Bounded, and anything token-like is masked.
 */
function diagnostic(message: string) {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "***")
    .replace(/sk-[\w-]{8,}/g, "***")
    .slice(0, 300);
}

export function chatGPTPlanProvider(
  provider: Provider,
  usageLimit?: (limited: boolean) => void,
  onRequest?: (route: { api: string; host: string }) => void,
  onFailure?: (route: { api: string; host: string; failure: string }) => void,
): Provider {
  const all = provider.getAllModels?.bind(provider) ?? provider.getModels.bind(provider);
  const wrap = (stream: Stream): Stream => {
    return (model, context, options) => {
      // Codes only, so a log can show which route a plan request took without any content.
      onRequest?.({ api: model.api, host: new URL(model.baseUrl).hostname });
      const source = stream(model, context, { ...options, maxRetries: 0 });
      const output = new AssistantMessageEventStream();
      void (async () => {
        try {
          for await (const event of source) {
            if (event.type === "done") usageLimit?.(false);
            else if (event.type === "error") {
              const message = event.error.errorMessage ?? "";
              onFailure?.({
                api: model.api,
                host: new URL(model.baseUrl).hostname,
                failure: diagnostic(message),
              });
              if (USAGE_LIMIT.test(message)) usageLimit?.(true);
              else if (NOT_ELIGIBLE.test(message)) {
                output.push({
                  ...event,
                  error: { ...event.error, errorMessage: CHATGPT_PLAN_NOT_ELIGIBLE },
                });
                continue;
              } else if (mapAgentError({ message }) === "auth_failed") {
                output.push({
                  ...event,
                  error: { ...event.error, errorMessage: CHATGPT_PLAN_DENIED },
                });
                continue;
              }
            }
            output.push(event);
          }
        } catch (error) {
          // pi turns provider failures into error events; a throwing iterator is a bug upstream.
          onFailure?.({
            api: model.api,
            host: new URL(model.baseUrl).hostname,
            failure: diagnostic(error instanceof Error ? error.message : "stream_failed"),
          });
          output.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: "error",
              errorMessage: "provider_error",
              timestamp: Date.now(),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          });
        } finally {
          output.end();
        }
      })();
      return output;
    };
  };
  return {
    ...provider,
    getAllModels: () =>
      all().filter((model) => model.type !== "image" && model.type !== "classifier"),
    generateImages: undefined,
    classify: undefined,
    stream: wrap(provider.stream.bind(provider) as Stream) as Provider["stream"],
    streamSimple: wrap(provider.streamSimple.bind(provider) as Stream) as Provider["streamSimple"],
  };
}
