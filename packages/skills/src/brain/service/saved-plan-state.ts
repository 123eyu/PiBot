import type { DatabaseSync } from "node:sqlite";
import { GroupPlanTemplateRunSchema, RpcError, RpcErrorCodes } from "@pibot/skills-contract/full";
import { GroupsRepo, GroupWorkflowsRepo, MessagesRepo, RunsRepo } from "@pibot/storage";
import { GroupSkillsRepo } from "../../store/skills/group-skills.ts";

/** Reads provenance, never infers a saved plan from its name or model-written text. */
export function savedPlanState(db: DatabaseSync, groupId: string, workflowRunId: string) {
  if (!new GroupsRepo(db).get(groupId))
    throw new RpcError(RpcErrorCodes.invalidParams, "workflow_group_unavailable");
  const record = new GroupWorkflowsRepo(db).get(workflowRunId);
  if (
    !record ||
    record.groupId !== groupId ||
    record.status !== "passed" ||
    (record.workflow as { source?: { kind?: unknown } }).source?.kind !== "dynamic"
  )
    return { state: "unavailable" as const };
  const root = record.budgetRootRunId ? new RunsRepo(db).get(record.budgetRootRunId) : undefined;
  const message = root?.userMessageId ? new MessagesRepo(db).get(root.userMessageId) : undefined;
  const usage = message?.usage;
  if (
    message?.role === "user" &&
    message.conversationId === root?.conversationId &&
    usage &&
    typeof usage === "object" &&
    !Array.isArray(usage) &&
    GroupPlanTemplateRunSchema.safeParse(usage.groupPlanTemplate).success
  )
    return { state: "rerun" as const };
  return {
    state: new GroupSkillsRepo(db, groupId).savedPlanExists(workflowRunId)
      ? ("saved" as const)
      : ("available" as const),
  };
}
