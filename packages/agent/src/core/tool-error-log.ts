import type { LocalToolCall, LocalToolErrorLog } from "./types.ts";

const IDENTIFIER = /^[A-Za-z0-9_.:$-]{1,64}$/;
const REASON = /^[a-z][a-z0-9_]{1,63}$/;
// A model-invented tool name or call id is still model output; anything unusual becomes `*`.
const safe = (value: unknown) =>
  typeof value === "string" && IDENTIFIER.test(value) ? value : "*";

/** Shared by the SDK gate and the brain's own synthetic steps so both log the same facts. */
export function toolErrorLog(
  event: LocalToolErrorLog["event"],
  call: Pick<LocalToolCall, "id" | "tool">,
  error: unknown,
): LocalToolErrorLog {
  // The class tells RpcError from a TypeError; `name` is the fallback for plain objects / bundles.
  const className = error instanceof Error ? error.constructor?.name : undefined;
  const errorName =
    error instanceof Error
      ? safe(className && className !== "Object" ? className : error.name)
      : typeof error;
  const raw = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  // `command_failed` alone said nothing about which phase failed; ExecError carries the
  // reason as a fixed identifier (process_kill_failed / cleanup_failed / process_snapshot_timeout).
  const rawReason =
    error && typeof error === "object" ? (error as { reason?: unknown }).reason : undefined;
  const message = error instanceof Error ? error.message : undefined;
  const code =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && IDENTIFIER.test(raw)
        ? raw
        : undefined;
  return {
    event,
    tool: safe(call.tool),
    toolCallId: safe(call.id),
    errorName,
    ...(code !== undefined ? { code } : {}),
    ...(event === "tool_authorization_failed"
      ? typeof rawReason === "string" && REASON.test(rawReason)
        ? { reason: rawReason }
        : typeof message === "string" && REASON.test(message)
          ? { reason: message }
          : { reason: "internal" }
      : typeof rawReason === "string" && IDENTIFIER.test(rawReason)
        ? { reason: rawReason }
        : {}),
  };
}
