import type { Run } from "@pibot/protocol-base";
import { ToolCallsRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/** A policy denial is a step blocker, not evidence that the shared cost ledger is exhausted. */
export function stepFailureReason(service: GroupService, run: Run | undefined, fallback: string) {
  if (!run) return fallback;
  if (run.status === "error" && run.errorCode === "budget_exhausted") return "budget_exhausted";
  if (run.status === "error" && run.errorCode === "permission_denied") return "permission_denied";
  // The member's own loop stopped only its run; the step names it instead of "interrupted".
  if (run.status === "error" && run.errorCode === "repeated_operation") return "repeated_operation";
  if (
    run.status === "error" &&
    ["agent_auth_failed", "agent_quota", "agent_rate_limited", "agent_model_unavailable"].includes(
      run.errorCode ?? "",
    )
  )
    return run.errorCode ?? fallback;
  if (run.status !== "done") return fallback;
  const rows = new ToolCallsRepo(service.deps.db).list(run.messageId, { limit: 1 });
  return rows[0]?.status === "blocked" ? "permission_denied" : fallback;
}
