import { keyPattern } from "../../packages/secrets/src/redaction/redaction-patterns.ts";

export type FailureKind = "task" | "harness";
export interface CheckFailure {
  kind: FailureKind;
  reason: string;
}

/** Unknown failures belong to the operator, rather than inviting a Bot to change product code. */
export function classifyFailure(
  run: { timedOut: boolean; errorCode?: string; signal?: string | null; code: number | null },
  _text: string,
  failed: string[],
): CheckFailure {
  if (run.timedOut) return { kind: "harness", reason: "command_timeout" };
  if (run.errorCode)
    return {
      kind: "harness",
      reason: /^(?:E[A-Z0-9_]{2,30}|ERR_[A-Z0-9_]{1,40})$/.test(run.errorCode)
        ? `command_start_failed:${run.errorCode}`
        : "command_start_failed",
    };
  // stdout may quote errors from task code or even successful parallel stages.
  if (run.signal) return { kind: "harness", reason: "command_signalled" };
  if (failed.includes("install")) return { kind: "harness", reason: "toolchain_unavailable" };
  if (run.code !== null && run.code > 0 && failed.length)
    return { kind: "task", reason: "task_check_failed" };
  return { kind: "harness", reason: "unclassified_check_failure" };
}

/** Exception messages may contain command arguments, output or secrets; persist fixed metadata only. */
export function exceptionReason(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "workflow_cancelled";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^(?:E[A-Z0-9_]{2,30}|ERR_[A-Z0-9_]{1,40})$/.test(code)
    ? `workflow_exception:${code}`
    : "workflow_exception";
}

export function safeExcerpt(text: string): string {
  const redacted = text
    .replace(keyPattern, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /(?<![\w-])(["']?)([A-Za-z0-9_-]{0,128}(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]{0,128})\1(\s*[=:]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/gi,
      "$1$2$1$3[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  if (redacted.length <= 6000) return redacted;
  // Startup output can be much longer than the actual diagnostic. Reserve space for the first
  // recognizable error, rather than assuming the stage's beginning contains the cause.
  const diagnostic =
    /\b(?:error\s+TS\d+\s*:|(?:[A-Za-z]*Error)\s*[:[]|FAIL(?:ED)?\s+(?!0\b)|TS\d{4}\s*:)/i.exec(
      redacted,
    );
  if (!diagnostic)
    return `${redacted.slice(0, 3200)}\n… [first diagnostic not recognized; output omitted] …\n${redacted.slice(-2400)}`;
  const start = Math.max(0, diagnostic.index - 400);
  return `${redacted.slice(0, 800)}\n… [first diagnostic context] …\n${redacted.slice(start, start + 2600)}\n… [output omitted] …\n${redacted.slice(-2400)}`;
}
