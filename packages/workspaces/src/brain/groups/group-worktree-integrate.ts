import { managedIdentity } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { RpcError } from "@pibot/workspaces-contract/full";
import { groupWorkplace } from "../runtime.ts";
import type { Active } from "./group-member-worktrees.ts";
import { groupWorktreeAuthority } from "./group-worktree-authority.ts";
import type { WorkspaceOperations } from "./group-worktree-create.ts";
import { groupWorktreeOperation } from "./group-worktree-operation.ts";

function fail(code: string): never {
  throw new RpcError(-32602, code);
}
/**
 * Plan steps (maintainers 2026-11-14) finish their merge before the tree goes: a managed folder
 * repository writes the result back into the user's folder, output files are copied out. A
 * refusal there throws, the tree stays for the coordinator, and nothing is half applied.
 */
export interface IntegrateHooks {
  /** Before the merge: the integration target as it is now (a managed folder syncs first). */
  beforeMerge?(signal: AbortSignal): Promise<void>;
  afterMerge?(input: { targetHead: string; signal: AbortSignal }): Promise<void>;
}
export async function integrateMemberWorktree(
  owner: WorkspaceOperations,
  active: Active,
  signal: AbortSignal,
  hooks: IntegrateHooks = {},
) {
  const { context, member, tree } = active,
    local = owner.service.deps.local;
  owner.current(context, member);
  const baseline = await groupWorkplace(
    local,
    context.botId,
    owner.service.active(member.groupId),
    signal,
  );
  if (
    baseline.boundary.roots.some(
      (root) =>
        root.role === "readonly" &&
        root.canonicalPath !== member.integrationPath &&
        containsPath(member.integrationPath, root.canonicalPath, local.deps.platform),
    )
  )
    fail("group_workspace_readonly");
  const host = owner.host(baseline.boundary);
  if (
    (member.executionLocation ?? null) !== (host.remote ? baseline.boundary.location?.target : null)
  )
    fail("group_workspace_changed");
  const { join } = host.paths;
  const authority = await groupWorktreeAuthority(
    local,
    context,
    baseline.boundary,
    [tree.path, tree.commonDir, member.integrationPath, join(tree.sourcePath, ".pibot", "wt")],
    signal,
    "integrate",
  );
  await owner.exclusive(
    `integrate:${tree.id}`,
    context.botId,
    [tree.path, tree.commonDir, member.integrationPath],
    signal,
    async () => {
      owner.current(context, member);
      owner.state(member, "integrating");
      owner.audit(context, "integrate", "started", tree.id);
      await hooks.beforeMerge?.(signal);
      let source = await owner.verify(tree, signal, host);
      const target = await host.inspect(member.integrationPath, signal);
      if (!target.clean || target.common.path !== source.common.path)
        fail("group_workspace_integration_dirty");
      source = await host.commit(source, {
        ...authority,
        home: baseline.home,
        dataDir: local.deps.dataDir,
        signal,
      });
      if (source.head !== target.head)
        await groupWorktreeOperation(
          owner,
          host,
          tree,
          {
            kind: "integrate",
            source,
            target,
            expectedSourceHead: source.head,
            expectedTargetHead: target.head,
            allowMerge: true,
          },
          { ...authority, home: baseline.home, dataDir: local.deps.dataDir, signal },
        );
      authority.assertAuthorized();
      await hooks.afterMerge?.({ targetHead: target.head, signal });
      owner.audit(context, "integrate", "done", tree.id);
      // Removal needs an ancestry witness in the actual group integration tree, not original main.
      const original = await host.inspect(tree.sourcePath, signal);
      const witness = await host.inspect(member.integrationPath, signal);
      // A runner checks the folder against the identity it reported on create.
      const allocation = owner.registry.allocationForTree(tree.id);
      const parent = host.remote
        ? allocation?.identity
        : await managedIdentity(join(tree.sourcePath, ".pibot", "wt"));
      if (!parent) fail("worktree_allocation_stale");
      await groupWorktreeOperation(
        owner,
        host,
        tree,
        {
          kind: "remove",
          source: original,
          worktree: source,
          managedId: tree.id,
          parent,
          integratedInto: witness,
        },
        { ...authority, home: baseline.home, dataDir: local.deps.dataDir, signal },
      );
      owner.registry.update(tree.id, tree.version, {
        state: "removed",
        head: source.head,
        identity: tree.identity,
      });
      owner.state(member, "integrated");
    },
    context.runId,
  );
}
