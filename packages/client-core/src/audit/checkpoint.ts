import type { TranslationKey } from "@pibot/i18n";
import type { AuditEntry } from "@pibot/protocol";
import type { AuditT } from "./facts.ts";

/** Also recognize historical records before the dedicated file audit kind existed. */
export function isFileCheckpoint(entry: Pick<AuditEntry, "kind" | "detail">): boolean {
  return (
    entry.kind === "file.checkpoint" ||
    (entry.kind === "exec.finished" && entry.detail.toolName === "managed.checkpoint_create")
  );
}

const skipReasons: Readonly<Record<string, TranslationKey>> = {
  checkpoint_bytes_quota: "checkpoint.skip.checkpoint_bytes_quota",
  project_items_quota: "checkpoint.skip.project_items_quota",
  snapshot_unavailable: "checkpoint.skip.snapshot_unavailable",
  authority_changed: "checkpoint.skip.authority_changed",
  capture_interrupted: "checkpoint.skip.capture_interrupted",
  capture_failed: "checkpoint.skip.capture_failed",
};

export function checkpointAuditResult(
  entry: AuditEntry,
  t: AuditT,
): {
  text: string;
  tone: "ok" | "warn" | "muted";
} {
  const reason = entry.detail.reasonCode;
  if (reason === "retained") return { text: t("audit.checkpoint.retained"), tone: "ok" };
  const key = reason && Object.hasOwn(skipReasons, reason) ? skipReasons[reason] : undefined;
  if (key) return { text: t(key), tone: "warn" };
  return { text: t("audit.result.recorded"), tone: "muted" };
}
