import { createHash } from "node:crypto";
import type { LocalToolResult } from "@pibot/agent";
import type { ToolJournalState } from "@pibot/storage";

export type SettledState = Exclude<ToolJournalState, "started">;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const COMMANDS = new Set(["run_command", "write_stdin", "background_command"]);
const SUMMARY_CHARS = 300;

/** Key-sorted JSON, so the same arguments in any key order have one digest. */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  return value;
}
export const argsDigest = (input: unknown) => sha256(JSON.stringify(canonicalValue(input)));
export const idempotencyKey = (root: string, tool: string, digest: string, ordinal: number) =>
  sha256(JSON.stringify([root, tool, digest, ordinal]));

/**
 * The journal state a finished call settles in, and what may be kept of its result: a digest of
 * the whole text, and a short summary built from structured facts (the step summary, an exit
 * code, a draft receipt's id and status), never the raw output, which can hold file contents.
 */
export function settledOutcome(
  tool: string,
  result: LocalToolResult,
  aborted: boolean,
  redact: (text: string) => string,
): { state: SettledState; summary: string; digest: string } {
  const digest = sha256(result.text);
  const short = (text: string) => redact(text).slice(0, SUMMARY_CHARS);
  if (tool === "connector_call") {
    const receipt = draftReceipt(result.text);
    if (receipt) return { state: receipt.state, summary: short(receipt.summary), digest };
  }
  let state: SettledState = !result.isError ? "done" : aborted ? "unknown" : "failed";
  if (
    tool === "write_file" &&
    result.isError &&
    result.details?.errorCode === "git_configuration_publication_unconfirmed"
  )
    state = "unknown";
  if (
    result.isError &&
    !aborted &&
    COMMANDS.has(tool) &&
    result.details &&
    "exitCode" in result.details
  )
    // The command ran: a numeric exit code is an explicit failure; none means it was killed or
    // timed out partway, with whatever it changed until then.
    state = typeof result.details.exitCode === "number" ? "failed" : "unknown";
  const facts = [
    result.summary,
    typeof result.details?.exitCode === "number" ? `exit code ${result.details.exitCode}` : "",
  ].filter(Boolean);
  return { state, summary: short(facts.length ? facts.join("; ") : `${tool}: ${state}`), digest };
}

/**
 * A connector write is a send draft: its receipt status is the outcome (the draft states are
 * merged into the journal). Sent or answered by an earlier attempt → done; discarded, expired or
 * failed → an explicit failure; pending, sending or unknown → unknown. A connector error code is a
 * refusal before anything was sent.
 */
function draftReceipt(text: string): { state: SettledState; summary: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not a receipt (a plain-text failure); the generic rules apply.
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string" && record.status === undefined)
    return { state: "failed", summary: JSON.stringify({ code: record.code.slice(0, 80) }) };
  if (typeof record.status !== "string") return undefined;
  const status = record.status;
  const state: SettledState =
    status === "sent" || record.duplicate === true
      ? "done"
      : ["failed", "discarded", "expired"].includes(status)
        ? "failed"
        : "unknown";
  return {
    state,
    summary: JSON.stringify({
      ...(typeof record.approvalId === "string" ? { approvalId: record.approvalId } : {}),
      status: status.slice(0, 40),
      ...(record.duplicate === true ? { duplicate: true } : {}),
    }),
  };
}

/** What the model receives instead of a repeated execution. */
export function replayResult(
  tool: string,
  kind: "done" | "running" | "unknown",
  summary: string | null,
): LocalToolResult {
  return {
    text: replayText(kind, summary),
    ...(kind !== "done" ? { isError: true } : {}),
    // The durable journal keeps no raw output provenance. A command receipt can refer to output
    // already present in restored history, so its replay conservatively keeps memory asking.
    ...(COMMANDS.has(tool) ? { untrustedContent: true } : {}),
  };
}

export function replayText(kind: "done" | "running" | "unknown", summary: string | null) {
  if (kind === "done")
    return `此操作在本任务中已执行过，未重复执行。上次结果：${summary ?? "已完成"} / This exact operation already ran in this task and was not repeated. Previous result: ${summary ?? "completed"}. Use read-only tools if you need the current state.`;
  if (kind === "running")
    return "同一操作正在执行，未再次启动 / The same operation is running right now; it was not started again.";
  return "此操作此前已开始但结果不明，未重复执行。请先用只读工具检查它是否已生效，不要再次发出同一调用；需要重做时请询问用户 / This exact operation started earlier but its outcome is unknown, so it was not repeated. Inspect with read-only tools whether it took effect and do not issue the same call again; ask the user if it must be redone.";
}
