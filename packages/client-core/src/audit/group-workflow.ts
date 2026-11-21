import type { TranslationKey } from "@pibot/i18n";
import type { AuditEntry } from "@pibot/protocol";
import type { AuditT } from "./facts.ts";

const summaries: Record<string, TranslationKey> = {
  "group.workflow.started": "audit.workflow.started",
  "group.workflow.migrated": "audit.workflow.migrated",
  "group.workflow.recovered": "audit.workflow.recovered",
  "group.workflow.step_dispatched": "audit.workflow.dispatched",
  "group.workflow.step_passed": "audit.workflow.passed",
  "group.workflow.step_failed": "audit.workflow.failed",
  "group.workflow.step_blocked": "audit.workflow.blocked",
  "group.workflow.step_merged": "audit.workflow.merged",
  "group.workflow.disposition": "audit.workflow.disposition",
  "group.workflow.completed": "audit.workflow.completed",
};

/** Persisted summaries may predate the current language; fixed event identities own the display. */
export function groupWorkflowSummary(entry: AuditEntry, t: AuditT): string | undefined {
  const key = summaries[entry.kind];
  if (!key) return;
  if (
    entry.kind === "group.workflow.disposition" &&
    entry.detail.reasonCode === "plan_manual_review"
  )
    return t("audit.workflow.review");
  return t(key);
}
