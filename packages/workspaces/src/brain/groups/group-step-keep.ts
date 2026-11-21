import type { StepKeep } from "@pibot/brain/kit";
import { RpcError } from "@pibot/workspaces-contract/full";
import { groupWorkplace } from "../runtime.ts";
import type { GroupMemberWorktrees } from "./group-member-worktrees.ts";
import { stepActor } from "./group-step-merge.ts";
import { isPlanStepWorkspace, moveStepOutput } from "./group-step-output.ts";

const NONE: StepKeep = { state: "none" };
const LOST: StepKeep = { state: "lost" };

function log(owner: GroupMemberWorktrees, event: string, fields: Record<string, unknown>) {
  owner.service.deps.local.deps.logger.warn(JSON.stringify({ module: "group", event, ...fields }));
}

/**
 * Maintainers 2026-11-21: a plan step the group's pause stopped goes on in the workspace it had, with
 * its unmerged changes. The same checks a later run's reattach makes are made here, before the
 * rerun is created, so a workspace that cannot be continued is discarded as before (and the
 * brief says so) instead of failing the rerun's prepare.
 */
export async function keepStepWorkspace(
  owner: GroupMemberWorktrees,
  taskId: string,
  botId: string,
  signal: AbortSignal,
): Promise<StepKeep> {
  const member = owner.repo.get(taskId);
  if (!member || member.state === "integrated" || member.state === "removed") return NONE;
  const tree = owner.registry.get(member.worktreeId);
  // A tree that never became ready, or a prepare stopped before the seed was written, means the
  // step never started working there: nothing of it is lost.
  if (!tree?.identity) return NONE;
  if (!(await isPlanStepWorkspace(owner.service.deps.local, taskId))) return NONE;
  if (
    member.state !== "working" ||
    tree.state !== "ready" ||
    member.botId !== botId ||
    tree.botId !== botId ||
    !owner.idle(member)
  )
    return LOST;
  try {
    const context = stepActor(owner, taskId, signal);
    const group = owner.current(context, member);
    const baseline = await groupWorkplace(owner.service.deps.local, botId, group, signal);
    const location =
      baseline.boundary.location && baseline.boundary.location.target !== "local"
        ? baseline.boundary.location.target
        : null;
    if ((member.executionLocation ?? null) !== location)
      throw new RpcError(-32602, "group_workspace_changed");
    await owner.verify(tree, signal, owner.host(baseline.boundary));
  } catch (error) {
    if (signal.aborted) throw error;
    log(owner, "step_workspace_keep_failed", {
      taskId,
      code: error instanceof RpcError ? error.message : "internal",
    });
    return LOST;
  }
  return { state: "kept", worktreeId: tree.id, version: tree.version };
}

/** Synchronous: runs inside the transaction that creates the rerun's task. */
export function adoptStepWorkspace(
  owner: GroupMemberWorktrees,
  fromTaskId: string,
  toTaskId: string,
  kept: Extract<StepKeep, { state: "kept" }>,
) {
  const tree = owner.registry.get(kept.worktreeId);
  if (!tree || tree.version !== kept.version || tree.state !== "ready") return false;
  return owner.repo.rekey(fromTaskId, toTaskId, kept.worktreeId);
}

export async function adoptedStepWorkspace(
  owner: GroupMemberWorktrees,
  fromTaskId: string,
  toTaskId: string,
) {
  try {
    await moveStepOutput(owner.service.deps.local, fromTaskId, toTaskId);
  } catch (error) {
    // The workspace still holds the work; only its output-folder carry-back is unknown, and the
    // step's merge then stops with an explicit failure instead of overwriting anything.
    log(owner, "step_workspace_seed_move_failed", {
      taskId: toTaskId,
      code: (error as NodeJS.ErrnoException).code ?? "internal",
    });
  }
}
