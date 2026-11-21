import {
  BotsRepo,
  ConversationsRepo,
  type DraftPayload,
  GroupCyclesRepo,
  GroupsRepo,
  GroupTasksRepo,
  RunsRepo,
} from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runPermissionScope } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { connectorDigest } from "../../runtime/tools/connectors/connector-tools.ts";
import { groupAuthorization } from "../../runtime/tools/local-prepare.ts";
import { routineWorkplace } from "../../runtime/unattended/workplace.ts";
import { fail } from "./draft-content.ts";

/** The checkpoint's read-only roots at the given paths, with the IDs the run used. */
export function readonlyRoots(
  roots: { id: string; path: string; role: "primary" | "readonly" | "writable" }[],
  paths: string[],
) {
  return roots
    .filter((root) => root.role === "readonly" && paths.includes(root.path))
    .map(({ id, path }) => ({ id, path }));
}

/** Reconstruct current authority from trusted origin IDs, never from user draft input. */
export function draftContext(
  local: LocalService,
  view: import("@pibot/protocol-base").DraftView,
  payload: DraftPayload,
): ToolRunContext {
  const db = local.deps.db;
  const approval = local.approvals.repo.get(view.approvalId);
  const conversation = new ConversationsRepo(db).get(view.conversationId);
  const bot = new BotsRepo(db).get(view.botId);
  if (!approval || !conversation || conversation.archivedAt || !bot || bot.archivedAt)
    return fail("draftUnavailable", "draft_source_unavailable");
  const origin = payload.origin;
  const context: ToolRunContext = {
    capabilities: local.capabilities.resolve({
      botId: view.botId,
      ...(payload.groupId ? { groupId: payload.groupId } : {}),
    }),
    botId: view.botId,
    conversationId: view.conversationId,
    runId: approval.runId,
    messageId: approval.messageId,
    groupId: payload.groupId,
    ...(origin?.executionTaskId ? { executionTaskId: origin.executionTaskId } : {}),
    ...(origin?.taskId ? { taskId: origin.taskId } : {}),
    ...(origin?.threadId ? { threadId: origin.threadId } : {}),
    ...(origin?.cycleId ? { cycleId: origin.cycleId } : {}),
    signal: local.shutdown.signal,
    language: "en",
  };
  if (origin?.routineRunId) {
    const owner = local.unattended;
    if (!owner) return fail("draftUnavailable", "draft_source_unavailable");
    const run = owner.run(origin.routineRunId);
    const routine = run.routineId ? owner.definition(run.routineId) : run.trialDraft;
    if (
      !routine ||
      ("deletedAt" in routine && (routine.deletedAt || !routine.enabled)) ||
      run.botId !== view.botId ||
      run.runId !== approval.runId ||
      run.conversationId !== view.conversationId ||
      !["running", "waiting"].includes(run.status) ||
      (run.status === "waiting" && run.waitCheckpoint?.approvalId !== view.approvalId)
    )
      return fail("draftUnavailable", "draft_source_unavailable");
    context.routineRunId = run.id;
    context.routineSource = run.reason === "trial" ? "trial" : "routine";
    context.routineWorkplace = {
      ...routineWorkplace(local, run.botId, routine),
      ...(run.reason === "trial" && run.waitCheckpoint
        ? {
            temporaryRoots: run.waitCheckpoint.workspaceSnapshot.roots
              .filter((root) =>
                run.trialDraft?.triggers.some((t) => {
                  const trigger = "config" in t ? t.config : t;
                  return trigger.kind === "folder" && trigger.path === root.path;
                }),
              )
              .map(({ id, path }) => ({ id, path })),
          }
        : {}),
      // The previous period's folder this run was given read-only.
      ...(run.reason !== "trial" && run.waitCheckpoint && owner.temporaryPaths
        ? {
            temporaryRoots: readonlyRoots(
              run.waitCheckpoint.workspaceSnapshot.roots,
              owner.temporaryPaths(run.id),
            ),
          }
        : {}),
    };
  } else if (origin?.executionTaskId || origin?.taskId) {
    const run = new RunsRepo(db).get(approval.runId);
    if (
      run?.status !== "running" ||
      run.botId !== view.botId ||
      run.conversationId !== view.conversationId
    )
      return fail("draftUnavailable", "draft_source_unavailable");
  }
  if (payload.groupId) {
    const group = new GroupsRepo(db).get(payload.groupId);
    if (
      !group ||
      group.paused ||
      conversation.groupId !== group.id ||
      !group.members.some((member) => member.botId === view.botId) ||
      (origin?.cycleId && new GroupCyclesRepo(db).get(group.id).cycleId !== origin.cycleId)
    )
      return fail("draftUnavailable", "draft_source_unavailable");
    if (origin?.taskId) {
      const task = new GroupTasksRepo(db, (text) => local.deps.redactor.redact(text)).get(
        origin.taskId,
      );
      if (
        task?.status !== "open" ||
        task.groupId !== group.id ||
        task.assigneeBotId !== view.botId ||
        task.threadConversationId !== view.conversationId
      )
        return fail("draftUnavailable", "draft_source_unavailable");
    }
    if (
      origin?.groupAuthorizationDigest &&
      connectorDigest(groupAuthorization(local, context)) !== origin.groupAuthorizationDigest
    )
      return fail("draftChanged", "draft_source_changed");
  }
  local.tasks.guardSync(context);
  context.permissionGroupId = runPermissionScope(local, context);
  if (local.execution.mode(context) === "plan") return fail("draftDenied", "draft_plan_denied");
  return context;
}
