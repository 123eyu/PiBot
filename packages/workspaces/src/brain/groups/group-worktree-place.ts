import type { ToolRunContext } from "@pibot/brain/kit";
import { workspaceBoundary } from "@pibot/brain/kit";
import { isManagedFolderRepository } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import type { ManagedRecord } from "@pibot/storage";
import { type Group, RpcError } from "@pibot/workspaces-contract/full";
import { groupWorkplace } from "../runtime.ts";
import type { GroupMemberWorktrees } from "./group-member-worktrees.ts";
import type { WorktreeHost } from "./group-worktree-host.ts";

type Place = Awaited<ReturnType<typeof groupWorkplace>>;
function fail(code: string): never {
  throw new RpcError(-32602, code);
}
export async function verifyMemberWorktree(
  git: Pick<WorktreeHost, "inspect">,
  tree: ManagedRecord,
  signal: AbortSignal,
) {
  if (tree.state !== "ready" || !tree.identity) fail("group_workspace_interrupted");
  const actual = await git.inspect(tree.path, signal);
  for (const key of ["root", "git", "common"] as const) {
    const expected = tree.identity[key],
      found = actual[key];
    if (
      expected.path !== found.path ||
      expected.device !== found.device ||
      expected.inode !== found.inode
    )
      fail("group_workspace_changed");
  }
  if (actual.branch !== `refs/heads/${tree.branch}`) fail("group_workspace_changed");
  return actual;
}

export async function resolveMemberWorkplace(
  owner: Pick<
    GroupMemberWorktrees,
    "service" | "repo" | "registry" | "current" | "verify" | "host"
  >,
  context: ToolRunContext,
  group: Group,
  parent: AbortSignal,
): Promise<Place> {
  const baseline = await groupWorkplace(owner.service.deps.local, context.botId, group, parent);
  if (!context.groupMemberWorktreeId) return baseline;
  const member = owner.repo.get(context.taskId as string),
    tree = owner.registry.get(context.groupMemberWorktreeId);
  if (
    !tree ||
    !member ||
    member.worktreeId !== tree.id ||
    member.state !== "working" ||
    tree.botId !== context.botId
  )
    fail("group_workspace_changed");
  owner.current(context, member);
  const remote = baseline.boundary.location && baseline.boundary.location.target !== "local";
  if ((member.executionLocation ?? null) !== (remote ? baseline.boundary.location?.target : null))
    fail("group_workspace_changed");
  await owner.verify(tree, parent, owner.host(baseline.boundary));
  if (remote) {
    // The worktree is a full checkout on the same runner: it alone is the member's workplace.
    // Adding the group folder as a read root would contain it and leave no write root.
    const place = await owner.service.deps.local.runtime.runnerWorkplace(
      {
        home: tree.path,
        currentId: tree.id,
        revision: baseline.boundary.revision,
        folders: [
          {
            id: tree.id,
            name: tree.branch,
            path: tree.path,
            location: baseline.boundary.location?.target,
            role: "primary",
          },
        ],
      },
      parent,
    );
    if (place?.boundary.conflict !== "none") fail("group_workspace_readonly");
    return place;
  }
  // A plan step on a non-Git folder branches from Pi Bot's repository inside that folder: the
  // repository is the one read-only source around the tree, so the folder itself (which also
  // contains the tree) is left out. Its files are in the repository copy.
  const managed = isManagedFolderRepository(baseline.boundary.primaryPath, tree.sourcePath);
  const platform = owner.service.deps.local.deps.platform;
  const roots = [
    { id: tree.id, path: tree.path, role: "primary" as const },
    ...baseline.boundary.roots
      .filter((r) => !managed || !containsPath(r.canonicalPath, tree.path, platform))
      .map((r) => ({
        id: r.id,
        path: r.canonicalPath,
        role: "readonly" as const,
      })),
  ];
  if (!roots.some((r) => r.path === tree.sourcePath))
    roots.push({ id: tree.requestId, path: tree.sourcePath, role: "readonly" });
  const boundary = await workspaceBoundary(
    roots,
    baseline.boundary.revision,
    owner.service.deps.local.deps.platform,
    parent,
    tree,
  );
  if (boundary.conflict !== "none") fail("group_workspace_readonly");
  return {
    ...baseline,
    cwd: tree.path,
    roots: boundary.readRoots,
    boundary,
    value: { ...baseline.value, home: tree.path, currentId: "home" },
  };
}
