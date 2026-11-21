import type { RoutineHistoryView } from "@pibot/protocol";
import type { AuditT } from "./facts.ts";
import { safeAuditText } from "./facts.ts";

export function routineRunName(run: RoutineHistoryView, t: AuditT) {
  if (run.reason === "trial") return t("activity.routineTrial");
  const name = safeAuditText(run.taskName ?? "", 200);
  if (!name) return t("activity.routineMissing");
  return run.taskDeleted ? t("activity.routineDeleted", { name }) : name;
}
export function routineRunStatus(run: RoutineHistoryView, t: AuditT) {
  const tone =
    run.status === "done"
      ? "ok"
      : run.status === "failed" || run.status === "timeout"
        ? "danger"
        : run.status === "running" || run.status === "waiting" || run.status === "missed"
          ? "warn"
          : "muted";
  return { text: t(`activity.routineStatus.${run.status}`), tone } as const;
}
