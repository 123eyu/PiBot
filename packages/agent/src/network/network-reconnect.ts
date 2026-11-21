import type { AssistantMessage } from "@earendil-works/pi-ai";
import { agentHttpStatus, mapAgentError } from "../core/errors.ts";

export const NETWORK_RETRY_SETTINGS = {
  enabled: false,
  maxRetries: 10,
  baseDelayMs: 2000,
  maxAgentDelayMs: 30_000,
} as const;

/** pi owns transcript recovery, backoff and cancellation; Pi Bot owns eligibility. */
export function enableNetworkRetry(message: AssistantMessage, blocked: boolean): boolean {
  if (blocked || message.stopReason !== "error") return false;
  const code = mapAgentError(message.errorMessage);
  const status = agentHttpStatus(message.errorMessage);
  const temporaryProviderFailure =
    (code === "provider_error" || code === "internal") &&
    ((status !== undefined && status >= 500) ||
      /\boverloaded\b|\bserver_busy\b|\bservers are currently busy\b|\bcurrently experiencing high demand\b|\bmodel is at capacity\b|\btemporarily unavailable\b|\bservice unavailable\b|\binternal[ _]?(?:server[ _]?)?error\b|\bserver_error\b|\bprovider returned error\b|服务暂时不可用|服务器繁忙|模型.*暂时.*(?:无法|不可用)/i.test(
        message.errorMessage ?? "",
      ));
  // Group and direct sessions share this gate, so delegation cannot accidentally lose retries.
  // Invalid credentials, exhausted quota, bad requests and context overflow need user action.
  if (code !== "network" && code !== "rate_limited" && !temporaryProviderFailure) return false;
  // pi's retry matcher consumes text. Normalize transport codes it may not know
  // (e.g. ECONNRESET), without persisting raw provider diagnostics or credentials.
  message.errorMessage =
    code === "network"
      ? status
        ? `Connection error. HTTP ${status}`
        : "Connection error."
      : code === "rate_limited"
        ? "HTTP 429 rate limit"
        : `HTTP ${status ?? 503} service unavailable`;
  return true;
}
