import { resolvePersonaLanguage, type StepMerge, type ToolRunContext } from "@pibot/brain/kit";
import { isManagedFolderRepository } from "@pibot/execution";
import { SettingsRepo } from "@pibot/storage";
import { RpcError } from "@pibot/workspaces-contract/full";
import { groupWorkplace } from "../runtime.ts";
import type { GroupMemberWorktrees } from "./group-member-worktrees.ts";
import { forgetStepOutput, stepOutputChanges, writeStepOutput } from "./group-step-output.ts";
import { integrateMemberWorktree } from "./group-worktree-integrate.ts";

/** Failures that mean "the same files changed on both sides", as opposed to a broken setup. */
const CONFLICTS = new Set([
  "file_conflict",
  "command_failed",
  "group_step_merge_conflict",
  "group_step_output_conflict",
]);
function code(error: unknown) {
  if (error instanceof RpcError) return error.message;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" && /^[a-z0-9_]{1,60}$/.test(value) ? value : "internal";
}
class MergeConflict extends RpcError {
  constructor(readonly files: string[]) {
    super(-32602, "group_step_merge_conflict");
  }
}

/**
 * The member's own finished step run is the actor: the merge is that member's work, and the
 * existing integration authority (policy, approval, YOLO, audit) judges it as it would any
 * integration. No coordinator model turn is spent per step.
 */
export function stepActor(
  owner: GroupMemberWorktrees,
  taskId: string,
  signal: AbortSignal,
): ToolRunContext {
  const member = owner.repo.get(taskId);
  const run = member?.runId ? owner.service.deps.chat.queue.repo.get(member.runId) : undefined;
  if (!member || !run) throw new RpcError(-32602, "group_workspace_missing");
  const group = owner.service.active(member.groupId);
  return {
    botId: member.botId,
    runId: run.id,
    messageId: run.messageId,
    conversationId: run.conversationId,
    groupId: member.groupId,
    ...(run.conversationId !== group.conversationId ? { threadId: run.conversationId } : {}),
    taskId,
    signal,
    ...(run.cycleId ? { cycleId: run.cycleId } : {}),
    // Approval cards are written in the person's language, as for any run's tool call.
    language: resolvePersonaLanguage(
      new SettingsRepo(owner.service.deps.local.deps.db).get().language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    ),
  };
}

/** Files both sides changed since the step branched: the likely conflict, for the coordinator. */
async function overlap(
  owner: GroupMemberWorktrees,
  worktree: string,
  target: string,
  base: string,
  signal: AbortSignal,
) {
  const changed = async (cwd: string) => {
    const result = await owner.reader.run(
      { op: "numstat", base },
      { cwd, signal, maxBytes: 256 * 1024 },
    );
    if (result.exitCode !== 0 || result.overflow) return new Set<string>();
    return new Set(
      result.stdout
        .toString("utf8")
        .split("\0")
        .map((entry) => entry.split("\t").slice(2).join("\t"))
        .filter(Boolean),
    );
  };
  const mine = await changed(worktree);
  const theirs = await changed(target);
  return [...mine].filter((file) => theirs.has(file)).slice(0, 20);
}

export async function mergeStep(
  owner: GroupMemberWorktrees,
  taskId: string,
  parent: AbortSignal,
): Promise<StepMerge> {
  const member = owner.repo.get(taskId);
  if (!member || member.state === "integrated") return { state: "merged" };
  if (member.state === "removed") return { state: "failed", code: "group_workspace_removed" };
  if (!owner.idle(member)) return { state: "pending" };
  const tree = owner.registry.get(member.worktreeId);
  if (!tree) return { state: "failed", code: "group_workspace_missing" };
  if (owner.pendingResources(member, tree, true)) return { state: "pending" };
  const local = owner.service.deps.local;
  const signal = owner.signal(parent);
  const context = stepActor(owner, taskId, signal);
  const group = owner.current(context, member);
  const baseline = await groupWorkplace(local, context.botId, group, signal);
  const primary = baseline.boundary.primaryPath;
  const managed = isManagedFolderRepository(primary, member.integrationPath);
  try {
    await owner.serial(
      `integrate:${member.groupId}:${member.sourceConversationId}`,
      signal,
      async () => {
        const current = owner.repo.get(taskId);
        if (current?.state === "integrated") return;
        if (!current || current.worktreeId !== tree.id || current.state === "removed")
          throw new RpcError(-32602, "group_workspace_changed");
        // Checked before anything merges: an output file someone else changed stops it cleanly.
        const outputs = await stepOutputChanges(
          local,
          baseline.boundary,
          { taskId, primary, workspace: tree.path },
          signal,
        );
        if (outputs.conflicts.length) throw new MergeConflict(outputs.conflicts);
        await integrateMemberWorktree(owner, { context, member: current, tree }, signal, {
          beforeMerge: managed
            ? async (inner) => {
                // The user's own edits since the last step enter Pi Bot's repository first, so a
                // clash with them is a Git conflict and nothing reaches the folder half applied.
                await owner.folders.sync({
                  folder: primary,
                  repository: member.integrationPath,
                  exclude: [local.deps.dataDir],
                  signal: inner,
                });
              }
            : undefined,
          afterMerge: async ({ targetHead, signal: inner }) => {
            if (managed) {
              const exported = await owner.folders.export({
                folder: primary,
                repository: member.integrationPath,
                signal: inner,
                assertAuthorized: () => owner.current(context, member),
              });
              if (exported.conflicts.length) {
                await owner.folders.rewind({
                  folder: primary,
                  repository: member.integrationPath,
                  head: targetHead,
                  signal: inner,
                });
                throw new MergeConflict(exported.conflicts.slice(0, 20));
              }
            }
            await writeStepOutput(outputs, inner);
          },
        });
      },
    );
  } catch (error) {
    if (parent.aborted) throw error;
    const reason = code(error);
    const latest = owner.repo.get(taskId);
    // Busy is a later retry; the half-started integration record goes back to waiting for it.
    if (reason === "group_workspace_busy" || reason === "group_workspace_not_drained") {
      if (latest?.state === "integrating") owner.state(latest, "awaiting_integration");
      return { state: "pending" };
    }
    if (latest && !["integrated", "removed"].includes(latest.state))
      owner.state(latest, "conflict", reason);
    if (error instanceof MergeConflict)
      return { state: "conflict", code: reason, files: error.files };
    if (!CONFLICTS.has(reason)) return { state: "failed", code: reason };
    const files =
      !tree.path || (baseline.boundary.location && baseline.boundary.location.target !== "local")
        ? []
        : await overlap(owner, tree.path, member.integrationPath, tree.baseHead, signal).catch(
            () => [],
          );
    return { state: "conflict", code: "group_step_merge_conflict", files };
  }
  await forgetStepOutput(local, taskId);
  return { state: "merged" };
}
