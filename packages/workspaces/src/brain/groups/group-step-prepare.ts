import type { PlanStepWorkspace, ToolRunContext } from "@pibot/brain/kit";
import { ExecError, ManagedFolderError, managedFolderRepository } from "@pibot/execution";
import { type Group, RpcError } from "@pibot/workspaces-contract/full";
import type { groupWorkplace } from "../runtime.ts";
import type { GroupMemberWorktrees } from "./group-member-worktrees.ts";
import { seedStepOutput } from "./group-step-output.ts";
import { groupWorktreeAuthority } from "./group-worktree-authority.ts";
import { createMemberWorktree } from "./group-worktree-create.ts";
import type { WorktreeHost } from "./group-worktree-host.ts";

type Place = Awaited<ReturnType<typeof groupWorkplace>>;
/** Setup facts that mean "no workspace here", never a broken one: the step takes turns instead. */
const TURNS = new Set([
  "runner_update_required",
  "worktree_quota",
  "group_workspace_integration_dirty",
  "group_workspace_layout_unsupported",
]);

/**
 * Where a writing plan step works (maintainers 2026-11-14): a clean Git repository gets an ordinary
 * managed worktree; any other folder on this desktop gets one branched from Pi Bot's own
 * repository for the plan inside that folder; a runner folder needs the runner's managed Git.
 * Whatever cannot have a workspace takes turns in the shared folder, with a fixed reason.
 */
export async function prepareStepWorktree(
  owner: GroupMemberWorktrees,
  context: ToolRunContext,
  group: Group,
  baseline: Place,
  task: { id: string; status: string },
  step: PlanStepWorkspace,
  signal: AbortSignal,
) {
  const local = owner.service.deps.local;
  const remote = !!baseline.boundary.location && baseline.boundary.location.target !== "local";
  const location = remote ? (baseline.boundary.location?.target ?? null) : null;
  const primary = baseline.boundary.primaryPath;
  const turns = (reason: string) => owner.takeTurns(context, task.id, reason);
  owner.stage(context.runId, "host");
  let host: WorktreeHost;
  try {
    host = owner.host(baseline.boundary);
  } catch (error) {
    if (error instanceof RpcError && TURNS.has(error.message)) return turns(error.message);
    throw error;
  }
  const retained = owner.repo.get(task.id);
  if (retained && retained.state !== "integrated")
    return owner.reattach(context, group, task, retained, host, location, signal);
  owner.stage(context.runId, "probe");
  const repository = (await host.isRepository(primary, signal).catch(() => false))
    ? await host.inspect(primary, signal).catch(() => undefined)
    : undefined;
  const usable =
    !!repository &&
    repository.clean &&
    repository.git.path === host.paths.join(primary, ".git") &&
    repository.common.path === repository.git.path;
  let place = baseline;
  if (!usable) {
    // Pi Bot's own repository is a desktop facility; a runner folder must already be Git.
    if (remote) return turns(repository ? "runner_folder_dirty" : "runner_folder_not_git");
    const managed = managedFolderRepository(primary, step.planKey);
    owner.stage(context.runId, "managed_folder");
    const authority = await groupWorktreeAuthority(
      local,
      context,
      baseline.boundary,
      [managed],
      signal,
      "create",
    );
    try {
      await owner.exclusive(`folder:${managed}`, context.botId, [managed], signal, async () => {
        authority.assertAuthorized();
        await owner.folders.sync({
          folder: primary,
          repository: managed,
          exclude: [local.deps.dataDir],
          signal,
        });
      });
    } catch (error) {
      if (error instanceof ManagedFolderError && error.folderCode === "managed_folder_too_large")
        return turns(error.folderCode);
      // Most Windows computers have no Git and Pi Bot ships none: parallel steps take turns in
      // the shared folder instead of failing every one of them as an internal error.
      if (error instanceof ExecError && error.code === "git_unavailable")
        return turns("git_unavailable");
      throw error;
    }
    place = { ...baseline, cwd: managed };
  }
  let active: Awaited<ReturnType<typeof createMemberWorktree>>;
  try {
    active = await createMemberWorktree(owner, host, context, group, place, signal);
  } catch (error) {
    if (error instanceof RpcError && TURNS.has(error.message)) return turns(error.message);
    throw error;
  }
  owner.active.set(context.runId, active);
  owner.stage(context.runId, "seed");
  await seedStepOutput(
    local,
    baseline.boundary,
    { taskId: task.id, primary, outputFolder: step.outputFolder, workspace: active.tree.path },
    signal,
  );
}
