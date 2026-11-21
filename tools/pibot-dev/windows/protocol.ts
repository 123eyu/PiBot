import type { CommandResult } from "./types.ts";

export const PREFIX = "PIBOT_WIN_RECEIPT ";
export interface RemoteReceipt {
  runId: string;
  stage: string;
  outcome: "ok" | "failed" | "harness_failed" | "skipped";
  reason: string;
  root64?: string;
}
export function remoteReceipts(run: CommandResult, runId: string): RemoteReceipt[] {
  const rows: RemoteReceipt[] = [];
  for (const line of run.out.split(/\r?\n/)) {
    if (!line.startsWith(PREFIX)) continue;
    const item: unknown = JSON.parse(line.slice(PREFIX.length));
    if (!item || typeof item !== "object") throw new Error("remote_receipt_invalid");
    const value = item as Record<string, unknown>;
    if (
      value.runId !== runId ||
      typeof value.stage !== "string" ||
      !/^[a-z-]{1,40}$/.test(value.stage) ||
      !["ok", "failed", "harness_failed", "skipped"].includes(String(value.outcome)) ||
      typeof value.reason !== "string" ||
      !/^[a-z_]{1,80}$/.test(value.reason) ||
      (value.root64 !== undefined &&
        (typeof value.root64 !== "string" || !/^[A-Za-z0-9+/]{1,4096}={0,2}$/.test(value.root64)))
    )
      throw new Error("remote_receipt_invalid");
    if (
      ![
        "idle",
        "prepare",
        "deploy",
        "transport",
        "cleanup",
        "first-screen",
        "backend-ready",
        "app-window",
      ].includes(value.stage) ||
      ![
        "owner_idle_unknown",
        "owner_busy",
        "owner_idle",
        "remote_temp_unavailable",
        "remote_prepared",
        "remote_prepare_failed",
        "already_clean",
        "resources_removed",
        "remote_cleanup_unconfirmed",
        "remote_deploy_failed",
        "remote_script_untrusted",
        "artifact_hash_mismatch",
        "test_copy_started",
        "application_error_log",
        "check_passed",
        "check_not_ready",
      ].includes(value.reason)
    )
      throw new Error("remote_receipt_invalid");
    if (value.root64 !== undefined && value.stage !== "prepare")
      throw new Error("remote_receipt_invalid");
    const expected: Record<string, readonly string[]> = {
      idle: ["ok:owner_idle", "skipped:owner_busy", "harness_failed:owner_idle_unknown"],
      prepare: [
        "ok:remote_prepared",
        "harness_failed:remote_temp_unavailable",
        "harness_failed:remote_prepare_failed",
      ],
      deploy: [
        "ok:test_copy_started",
        "failed:application_error_log",
        "harness_failed:remote_deploy_failed",
        "harness_failed:artifact_hash_mismatch",
      ],
      transport: ["harness_failed:remote_script_untrusted"],
      cleanup: [
        "ok:already_clean",
        "ok:resources_removed",
        "harness_failed:remote_cleanup_unconfirmed",
      ],
      "first-screen": ["ok:check_passed", "failed:check_not_ready"],
      "backend-ready": ["ok:check_passed", "failed:check_not_ready"],
      "app-window": ["ok:check_passed", "failed:check_not_ready"],
    };
    if (!expected[value.stage]?.includes(`${value.outcome}:${value.reason}`))
      throw new Error("remote_receipt_invalid");
    rows.push(value as unknown as RemoteReceipt);
    if (rows.length > 20) throw new Error("remote_receipt_limit");
  }
  return rows;
}
export function commandReason(run: CommandResult): string | undefined {
  if (!run.drained) return "local_process_cleanup_unconfirmed";
  if (run.stopped) return `command_${run.stopped}`;
  if (run.errorCode) return "command_start_failed";
  if (run.signal) return "command_signalled";
  if (run.code !== 0) return "command_exit_failed";
}
/** Remote paths are used by SFTP, never interpolated into a shell command. */
export function remoteRoot(receipt: RemoteReceipt, runId: string): string {
  const root = Buffer.from(receipt.root64 ?? "", "base64").toString("utf8");
  if (
    !/^[A-Za-z]:\\/.test(root) ||
    /[\r\n\0"<>|]/.test(root) ||
    root.split("\\").some((part) => part === "." || part === "..") ||
    !root.endsWith(`\\pibot-dev-${runId}`)
  )
    throw new Error("remote_temp_unsupported");
  return root;
}
