import type { TranslationKey } from "@pibot/i18n";
import type { AuditEntry, AuditKind } from "@pibot/protocol";
import type { AuditT } from "./facts.ts";

type RoutineAuditKind = Extract<AuditKind, `routine.${string}`>;
// Keep the display and query contract exhaustive when protocol adds a lifecycle event.
const summaries = {
  "routine.created": "audit.routine.created",
  "routine.updated": "audit.routine.updated",
  "routine.deleted": "audit.routine.deleted",
  "routine.paused": "audit.routine.paused",
  "routine.resumed": "audit.routine.resumed",
  "routine.proposed": "audit.routine.proposed",
  "routine.proposal.resolved": "audit.routine.proposalResolved",
  "routine.preauth.allowed": "audit.routine.preauthRecorded",
  "routine.preauth.revoked": "audit.routine.preauthRevoked",
  "routine.run.cancelled": "audit.routine.runStopped",
} satisfies Record<RoutineAuditKind, TranslationKey>;

export const routineAuditKinds = Object.keys(summaries) as RoutineAuditKind[];
export function isRoutineAuditKind(kind: AuditKind): kind is RoutineAuditKind {
  return Object.hasOwn(summaries, kind);
}

export function routineAuditReason(entry: AuditEntry, t: AuditT): string | undefined {
  const reason = entry.detail.reasonCode ?? entry.detail.reason;
  if (reason === "pause_all" && entry.kind === "routine.resumed") return t("tray.routinesResume");
  const keys: Record<string, TranslationKey> = {
    pause_all: "audit.routine.pauseAll",
    away_7d: "routines.paused.away_7d",
    trigger_error: "routines.paused.trigger_error",
    bot_archived: "routines.paused.bot_archived",
    resume_away: "audit.routine.resumeAway",
    cancelled: "audit.reason.stopped",
    routine_preauth: "audit.routine.preauthUsed",
    explicit_consent: "audit.result.confirmed",
    // Migration 0102.
    workflow_retired: "audit.routine.workflowRetired",
    workflow_saved_plan: "audit.routine.workflowSavedPlan",
    workflow_unavailable: "audit.routine.workflowUnavailable",
    workflow_retire_failed: "audit.routine.workflowRetireFailed",
  };
  const key = reason && Object.hasOwn(keys, reason) ? keys[reason] : undefined;
  return key ? t(key) : undefined;
}

function proposalKey(reason: string | undefined): TranslationKey {
  switch (reason) {
    case "accepted":
      return "audit.routine.proposalAccepted";
    case "declined":
      return "audit.routine.proposalDeclined";
    case "expired":
      return "audit.routine.proposalExpired";
    default:
      return "audit.routine.proposalResolved";
  }
}

export function routineAuditSummary(entry: AuditEntry, t: AuditT): string {
  if (!isRoutineAuditKind(entry.kind)) return t("audit.result.recorded");
  if (entry.kind === "routine.proposal.resolved") return t(proposalKey(entry.detail.reason));
  if (entry.kind === "routine.preauth.allowed")
    return t(
      entry.detail.reasonCode === "explicit_consent"
        ? "audit.routine.preauthGranted"
        : entry.detail.reasonCode === "routine_preauth"
          ? "audit.routine.preauthUsed"
          : "audit.routine.preauthRecorded",
    );
  if (entry.kind === "routine.run.cancelled" && entry.detail.source === "trial")
    return t("audit.routine.trialStopped");
  return t(summaries[entry.kind]);
}

export function routineAuditResult(
  entry: AuditEntry,
  t: AuditT,
): { text: string; tone: "ok" | "warn" | "danger" | "muted" } {
  const result = (key: TranslationKey, tone: "warn" | "muted" = "muted") => ({
    text: t(key),
    tone,
  });
  switch (entry.kind) {
    case "routine.created":
      return result("audit.result.created");
    case "routine.updated":
      return result("audit.result.changed");
    case "routine.deleted":
      return result("audit.result.deleted");
    case "routine.paused":
      return result("audit.result.paused", "warn");
    case "routine.resumed":
      return result("audit.result.resumed");
    case "routine.proposed":
      return result("activity.waiting", "warn");
    case "routine.proposal.resolved":
      switch (entry.detail.reason) {
        case "accepted":
          return result("audit.result.confirmed");
        case "declined":
          return result("audit.result.declined");
        case "expired":
          return result("audit.result.expired", "warn");
        default:
          return result("audit.result.recorded");
      }
    case "routine.preauth.allowed":
      return result(
        entry.detail.reasonCode === "explicit_consent"
          ? "audit.result.confirmed"
          : entry.detail.reasonCode === "routine_preauth"
            ? "activity.autoAllowed"
            : "audit.result.recorded",
      );
    case "routine.preauth.revoked":
      return result("audit.result.revoked");
    case "routine.run.cancelled":
      return result("audit.result.stopped");
    default:
      return result("audit.result.recorded");
  }
}
