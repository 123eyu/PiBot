import type { Logger } from "@pibot/observability";
import { z } from "zod";
import { PowerShellWorkerError } from "./powershell-worker.ts";

export const WINDOWS_SECURITY_CHECK_CODES = [
  "interactive_user_required",
  "reparse_denied",
  "owner_denied",
  "acl_missing",
  "acl_not_private",
  "directory_inheritance_enabled",
  "listener_identity_changed",
  "listener_missing",
  "process_identity_changed",
  "process_owner_changed",
  "ancestor_unknown",
  "ancestor_owner_unknown",
  "ancestor_replaceable",
  "unknown",
] as const;

type CheckCode = (typeof WINDOWS_SECURITY_CHECK_CODES)[number];
type Reason =
  | "timeout"
  | "aborted"
  | "max_buffer"
  | "nonzero"
  | "spawn"
  | "execution_failed"
  | "invalid_result"
  | "security_rejected";

const FailureSchema = z.strictObject({
  ok: z.literal(false),
  reason: z.enum(WINDOWS_SECURITY_CHECK_CODES),
});

export class WindowsSecurityError extends Error {
  constructor(
    readonly reason: Reason,
    readonly check?: CheckCode,
  ) {
    super(`background_windows_security_${reason}${check ? `_${check}` : ""}`);
  }
}

/** A worker result that is a well-formed refusal names the failed check; anything else does not. */
export function securityCheckFailure(value: unknown): CheckCode | undefined {
  const result = FailureSchema.safeParse(value);
  return result.success ? result.data.reason : undefined;
}

function checkFailure(stdout: string | undefined): CheckCode | undefined {
  if (!stdout) return undefined;
  try {
    const result = FailureSchema.safeParse(JSON.parse(stdout));
    return result.success ? result.data.reason : undefined;
  } catch {
    // Arbitrary child output must never become a diagnostic message.
    return undefined;
  }
}

export function windowsSecurityFailure(
  error: unknown,
  signal: AbortSignal,
  stdout?: string,
): WindowsSecurityError {
  if (signal.aborted)
    return new WindowsSecurityError(
      signal.reason instanceof Error && signal.reason.name === "TimeoutError"
        ? "timeout"
        : "aborted",
    );
  if (error instanceof WindowsSecurityError) return error;
  if (error instanceof PowerShellWorkerError)
    return new WindowsSecurityError(
      error.reason === "exited"
        ? "execution_failed"
        : error.reason === "aborted"
          ? "aborted"
          : error.reason,
    );
  const value = error as { code?: unknown; killed?: unknown; signal?: unknown } | null;
  if (value?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return new WindowsSecurityError("max_buffer");
  if (value?.killed === true && value.signal === "SIGTERM")
    return new WindowsSecurityError("timeout");
  if (typeof value?.code === "number") {
    const check = checkFailure(stdout);
    return check
      ? new WindowsSecurityError("security_rejected", check)
      : new WindowsSecurityError("nonzero");
  }
  return new WindowsSecurityError(typeof value?.code === "string" ? "spawn" : "execution_failed");
}

export function reportWindowsSecurityFailure(
  logger: Pick<Logger, "warn">,
  operation: "create" | "check" | "owner" | "seal",
  failure: WindowsSecurityError,
  started: number,
) {
  logger.warn(
    JSON.stringify({
      module: "background",
      event: "windows_security_failed",
      operation,
      reason: failure.reason,
      ...(failure.check ? { check: failure.check } : {}),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    }),
  );
}
