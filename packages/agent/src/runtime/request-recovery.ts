import type { AssistantMessage, ProviderResponse } from "@earendil-works/pi-ai";

export const CONNECTION_RETRY_DELAYS = [1_000, 4_000, 8_000, 16_000, 30_000] as const;
export const MALFORMED_CALL_MAX_RETRIES = 2;
export type RequestRetry = {
  kind: "connection" | "malformed";
  delayMs: number;
  attempt: number;
  maxAttempts: number;
};

export const MALFORMED_CALL_HINT =
  "上一次工具调用格式无效，未执行该调用。请按当前工具参数 schema 重新生成调用；不要重复已成功的操作。 / The last tool call was malformed and was not executed. Resend it using the current tool argument schema; do not repeat completed operations.";

/** HTTP dates and delta-seconds are the only accepted forms; headers never become diagnostics. */
export function retryAfterMillis(value: string | undefined, now = Date.now()): number | undefined {
  if (!value || value.length > 128) return undefined;
  const text = value.trim();
  const millis = /^\d+(?:\.\d+)?$/.test(text)
    ? Number(text) * 1000
    : /^[A-Za-z]{3}, /.test(text)
      ? Date.parse(text) - now
      : Number.NaN;
  return Number.isSafeInteger(Math.ceil(millis)) ? Math.max(0, Math.ceil(millis)) : undefined;
}

export class RequestRecovery {
  attempts = 0;
  hint?: string;
  private after?: number;
  resetResponse() {
    this.after = undefined;
  }
  response(response: ProviderResponse) {
    if (response.status !== 429) return;
    const header = Object.entries(response.headers).find(
      ([key]) => key.toLowerCase() === "retry-after",
    )?.[1];
    this.after = retryAfterMillis(header);
  }
  next(
    message: AssistantMessage,
    rateLimited: boolean,
    connectionAttempts: number,
  ): RequestRetry | undefined {
    const malformed =
      message.rawStopReason?.toLowerCase() === "malformed_function_call" ||
      /\bmalformed_function_call\b/i.test(message.errorMessage ?? "");
    if (malformed) {
      if (this.attempts >= MALFORMED_CALL_MAX_RETRIES) return undefined;
      this.hint = MALFORMED_CALL_HINT;
      return {
        kind: "malformed",
        delayMs: 0,
        attempt: ++this.attempts,
        maxAttempts: MALFORMED_CALL_MAX_RETRIES,
      };
    }
    if (!rateLimited || connectionAttempts >= CONNECTION_RETRY_DELAYS.length) return undefined;
    // Daily quotas can advertise hours of waiting; surface the limit instead of stalling a run.
    if (rateLimited && this.after !== undefined && this.after > 60_000) return undefined;
    return {
      kind: "connection",
      delayMs: this.after ?? (CONNECTION_RETRY_DELAYS[connectionAttempts] as number),
      attempt: connectionAttempts + 1,
      maxAttempts: CONNECTION_RETRY_DELAYS.length,
    };
  }
}
