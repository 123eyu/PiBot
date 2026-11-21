import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  isManagedFolderRepository,
  managedFolderRepository,
  managedIdentity,
} from "@pibot/execution";
import type { GroupMemberWorkspace } from "@pibot/storage";
import { RpcError } from "@pibot/workspaces-contract/full";
import { groupWorkplace } from "../runtime.ts";
import type { GroupMemberWorktrees } from "./group-member-worktrees.ts";
import { stepActor } from "./group-step-merge.ts";
import { forgetStepOutput } from "./group-step-output.ts";
import { groupWorktreeAuthority } from "./group-worktree-authority.ts";
import { groupWorktreeOperation } from "./group-worktree-operation.ts";

const DONE = new Set(["integrated", "removed"]);

/** The folder a step workspace mirrors: the primary itself, or the one owning Pi Bot's repo. */
function primaryOf(member: GroupMemberWorkspace) {
  const candidate = path.dirname(path.dirname(path.dirname(member.integrationPath)));
  return isManagedFolderRepository(candidate, member.integrationPath)
    ? candidate
    : member.integrationPath;
}

export function stepWorkspaceRoot(
  owner: GroupMemberWorktrees,
  member: GroupMemberWorkspace,
  integrated = false,
) {
  const tree = owner.registry.get(member.worktreeId);
  if (!tree || (!integrated && tree.state !== "ready")) return undefined;
  return { root: tree.path, primary: primaryOf(member) };
}

function log(owner: GroupMemberWorktrees, event: string, fields: Record<string, unknown>) {
  owner.service.deps.local.deps.logger.warn(JSON.stringify({ module: "group", event, ...fields }));
}

/**
 * Removes a step workspace that will never be merged (a redone attempt, a conflict the plan moved
 * past, an ended plan). Its work is committed to its own branch first, and that branch stays, as
 * for every other cleanup of a managed worktree; inside Pi Bot's folder repository the whole
 * repository goes with the plan, so only the records are closed here.
 */
export async function discardStepWorkspace(
  owner: GroupMemberWorktrees,
  taskId: string,
  signal: AbortSignal,
) {
  const member = owner.repo.get(taskId);
  if (!member || DONE.has(member.state) || !owner.idle(member)) return;
  const tree = owner.registry.get(member.worktreeId);
  const close = () => {
    const current = owner.registry.get(member.worktreeId);
    if (current && current.state !== "removed")
      owner.registry.update(current.id, current.version, {
        state: "removed",
        head: current.head,
        identity: current.identity,
      });
    owner.state(member, "removed");
  };
  if (!tree || tree.state === "removed" || primaryOf(member) !== member.integrationPath) {
    close();
    await forgetStepOutput(owner.service.deps.local, taskId);
    return;
  }
  const local = owner.service.deps.local;
  try {
    const context = stepActor(owner, taskId, signal);
    const group = owner.current(context, member);
    const baseline = await groupWorkplace(local, context.botId, group, signal);
    const host = owner.host(baseline.boundary);
    const parentPath = host.paths.join(tree.sourcePath, ".pibot", "wt");
    const authority = await groupWorktreeAuthority(
      local,
      context,
      baseline.boundary,
      [tree.path, tree.commonDir, parentPath],
      signal,
      "discard",
    );
    const dispatch = { ...authority, home: baseline.home, dataDir: local.deps.dataDir, signal };
    await owner.exclusive(
      `discard:${tree.id}`,
      context.botId,
      [tree.path, tree.commonDir],
      signal,
      async () => {
        let worktree = await owner.verify(tree, signal, host);
        worktree = await host.commit(worktree, dispatch);
        const allocation = owner.registry.allocationForTree(tree.id);
        const parent = host.remote ? allocation?.identity : await managedIdentity(parentPath);
        if (!parent) throw new RpcError(-32602, "worktree_allocation_stale");
        await groupWorktreeOperation(
          owner,
          host,
          tree,
          {
            kind: "remove",
            source: await host.inspect(tree.sourcePath, signal),
            worktree,
            managedId: tree.id,
            parent,
            preserveBranch: true,
          },
          dispatch,
        );
        owner.registry.update(tree.id, tree.version, {
          state: "removed",
          head: worktree.head,
          identity: tree.identity,
        });
        owner.state(member, "removed");
      },
    );
    await forgetStepOutput(local, taskId);
  } catch (error) {
    if (signal.aborted) throw error;
    // The tree stays listed under the topic's workspaces, where a person can still remove it.
    log(owner, "step_workspace_discard_deferred", {
      taskId,
      code: error instanceof RpcError ? error.message : "internal",
    });
  }
}

/** Pi Bot's folder repository of a plan, once none of its step workspaces is still running. */
export async function endPlanWorkspaces(
  owner: GroupMemberWorktrees,
  primaryPath: string,
  planKey: string,
) {
  let repository: string;
  try {
    repository = managedFolderRepository(primaryPath, planKey);
  } catch {
    return; // Not a plan key this module ever used for a repository.
  }
  const members = owner.repo.byIntegrationPath(repository);
  if (members.some((member) => !DONE.has(member.state) && !owner.idle(member))) return;
  for (const member of members) {
    if (DONE.has(member.state)) continue;
    const tree = owner.registry.get(member.worktreeId);
    if (tree && tree.state !== "removed")
      owner.registry.update(tree.id, tree.version, {
        state: "removed",
        head: tree.head,
        identity: tree.identity,
      });
    owner.state(member, "removed");
    await forgetStepOutput(owner.service.deps.local, member.taskId);
  }
  try {
    await owner.folders.remove({ folder: primaryPath, repository });
  } catch (error) {
    log(owner, "managed_folder_remove_deferred", {
      code: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Repositories a crash may have left behind, found by their fixed place in the folder. */
export async function managedPlanKeys(primaryPath: string) {
  try {
    const names = await readdir(path.join(primaryPath, ".pibot", "managed-git"));
    return names.filter((name) => {
      try {
        return isManagedFolderRepository(primaryPath, managedFolderRepository(primaryPath, name));
      } catch {
        return false; // Not a name Pi Bot ever creates; it is left alone.
      }
    });
  } catch {
    return []; // No container (the usual case): nothing to clean.
  }
}
