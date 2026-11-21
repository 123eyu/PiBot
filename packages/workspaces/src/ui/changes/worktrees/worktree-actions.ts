import type { ChangesTarget, ManagedWorktree } from "@pibot/workspaces-contract/full";
import type { ManagedResourcesApi } from "./managed-resource-api.ts";

/** Only the management list can issue fresh versions and inspected merge preconditions. */
export async function inspectManagedTree(
  api: ManagedResourcesApi,
  target: ChangesTarget,
  id: string,
  signal: AbortSignal,
) {
  let before: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await api.call(
      "worktrees.list",
      { target, limit: 50, ...(before ? { before } : {}) },
      { signal, timeoutMs: 30_000 },
    );
    const found = page.items.find((tree) => tree.id === id);
    if (found) return found;
    before = page.nextBefore ?? undefined;
    if (before && seen.has(before)) throw new Error("worktree_stale");
    if (before) seen.add(before);
  } while (before && seen.size < 250);
  throw new Error("worktree_stale");
}
export async function mutateWorktree(
  api: ManagedResourcesApi,
  target: ChangesTarget,
  tree: ManagedWorktree,
  removing: boolean,
  signal: AbortSignal,
) {
  const common = { requestId: crypto.randomUUID(), expectedVersion: tree.version };
  const groupId = target.conversationKey.startsWith("group:")
    ? target.conversationKey.slice(6)
    : undefined;
  const options = { signal, timeoutMs: 120_000 };
  if (removing) {
    return tree.taskId && groupId
      ? api.call(
          "groups.tasks.worktree.remove",
          { groupId, taskId: tree.taskId, ...common },
          options,
        )
      : api.call("worktrees.remove", { target, id: tree.id, ...common }, options);
  }
  if (
    !tree.head ||
    !tree.sourceHead ||
    tree.sourceClean !== true ||
    (!tree.taskId && tree.clean !== true)
  )
    throw new Error("worktree_dirty");
  const heads = { expectedTargetHead: tree.sourceHead, expectedWorktreeHead: tree.head };
  return tree.taskId && groupId
    ? api.call(
        "groups.tasks.worktree.integrate",
        { groupId, taskId: tree.taskId, ...common, ...heads },
        options,
      )
    : api.call("worktrees.integrate", { target, id: tree.id, ...common, ...heads }, options);
}
