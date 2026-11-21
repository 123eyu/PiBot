import { join } from "node:path";
import type { WorkspaceGroups as GroupService } from "@pibot/brain/kit";
import { managedIdentity } from "@pibot/execution";
import { transaction } from "@pibot/storage";
import { ManagedWorktreeSchema, type MethodParams } from "@pibot/workspaces-contract/full";
import { preserveManagedFailure } from "../managed/managed-failure.ts";
import type { ManagedResourcePorts } from "../managed/managed-resource-ports.ts";
import { managedError, primaryManagedScope } from "../managed/managed-resource-ports.ts";
import type { GroupMemberWorktrees } from "./group-member-worktrees.ts";
import { isPlanStepWorkspace } from "./group-step-output.ts";
import { commitGroupWorktree } from "./group-worktree-commit.ts";

type Integrate = MethodParams["groups.tasks.worktree.integrate"];
type Remove = MethodParams["groups.tasks.worktree.remove"];

/** Explicit user actions use the same user lease and policy as ordinary managed Git clicks. */
export class GroupTaskWorktreeActions {
  constructor(
    private readonly groups: GroupService,
    private readonly ports: ManagedResourcePorts,
    private readonly owner: GroupMemberWorktrees,
  ) {}
  integrate(input: Integrate, signal: AbortSignal) {
    return this.perform(input, "integrate", signal);
  }
  remove(input: Remove, signal: AbortSignal) {
    return this.perform(input, "remove", signal);
  }
  private async perform(
    input: Integrate | Remove,
    action: "integrate" | "remove",
    signal: AbortSignal,
  ) {
    const owner = this.owner,
      local = this.groups.deps.local;
    const group = this.groups.active(input.groupId);
    const resolved = await this.ports.scope({ conversationKey: `group:${input.groupId}` }, signal);
    // Registry viewers are presentation choices, not additional execution grants or denials.
    const scope = { ...resolved, roots: resolved.roots.filter((root) => root.kind !== "worktree") };
    primaryManagedScope(scope);
    const member = owner.repo.get(input.taskId),
      task = this.groups.tasks.get(input.taskId);
    if (
      !member ||
      !task ||
      member.groupId !== group.id ||
      task.groupId !== group.id ||
      task.assigneeBotId !== member.botId ||
      !group.members.some((person) => person.botId === member.botId) ||
      task.source?.conversationId !== member.sourceConversationId ||
      member.sourceConversationId !== group.conversationId ||
      scope.conversationId !== group.conversationId ||
      scope.primary.path !== member.integrationPath ||
      (group.workspaceRevision ?? 0) !== member.workspaceRevision
    )
      managedError("group_workspace_changed");
    const tree = owner.registry.get(member.worktreeId);
    if (!tree || tree.botId !== member.botId) managedError("group_workspace_missing");
    // These buttons still use the desktop's managed-resource ports; a runner worktree is
    // integrated by its coordinator instead of failing here half-way on the wrong disk.
    if (member.executionLocation)
      managedError("group_workspace_runner_action_unsupported", "unsupported");
    const view = () =>
      ManagedWorktreeSchema.strip().parse({
        ...owner.registry.get(tree.id),
        taskId: task.id,
        integrationPath: member.integrationPath,
      });
    const expected = JSON.stringify({
      version: input.expectedVersion,
      ...(action === "integrate"
        ? {
            targetHead: (input as Integrate).expectedTargetHead,
            worktreeHead: (input as Integrate).expectedWorktreeHead,
          }
        : {}),
    });
    const duplicate = owner.registry.operation(input.requestId);
    if (duplicate) {
      if (
        duplicate.worktreeId !== tree.id ||
        duplicate.kind !== action ||
        duplicate.expected !== expected
      )
        managedError("worktree_request_conflict");
      if (duplicate.state === "done") return view();
      managedError("worktree_interrupted");
    }
    if (
      tree.state !== "ready" ||
      tree.version !== input.expectedVersion ||
      member.state === "removed" ||
      member.state === "integrated"
    )
      managedError("worktree_stale");
    if (action === "integrate" ? task.status !== "done" : task.status === "open")
      managedError("group_workspace_task_unfinished");
    // A plan step's merge also carries its output files; the program does it after its checks.
    if (action === "integrate" && (await isPlanStepWorkspace(local, task.id)))
      managedError("managed_plan_step_merge");
    if (["preparing", "integrating"].includes(member.state)) managedError("worktree_busy", "busy");
    const paths = [
      tree.path,
      tree.commonDir,
      member.integrationPath,
      join(tree.sourcePath, ".pibot", "wt"),
    ];
    await this.ports.assertIdle(scope, paths, signal);
    if (await this.ports.referenced(tree.path, signal)) managedError("worktree_bound", "busy");
    if (owner.registry.bindings(tree.id).length) managedError("worktree_bound", "busy");
    const authority = await this.ports.authorize(scope, action, paths, signal);
    const dispatch = { ...authority, home: scope.home, dataDir: this.ports.dataDir, signal };
    const assertScope = () => {
      const now = this.groups.active(group.id),
        current = owner.registry.get(tree.id);
      if (
        now.conversationId !== member.sourceConversationId ||
        (now.workspaceRevision ?? 0) !== member.workspaceRevision ||
        current?.version !== tree.version ||
        current.state !== "ready"
      )
        managedError("worktree_stale");
    };
    const assertCurrent = () => {
      authority.assertAuthorized();
      assertScope();
    };
    const source = await owner.git.inspect(tree.sourcePath, signal),
      initial = await owner.verify(tree, signal),
      target = await owner.git.inspect(member.integrationPath, signal);
    if (
      source.root.device !== tree.sourceIdentity.device ||
      source.root.inode !== tree.sourceIdentity.inode ||
      source.common.path !== tree.commonDir ||
      target.common.path !== tree.commonDir
    )
      managedError("worktree_identity_changed");
    if (
      action === "integrate" &&
      (initial.head !== (input as Integrate).expectedWorktreeHead ||
        target.head !== (input as Integrate).expectedTargetHead)
    )
      managedError("worktree_stale");
    if (action === "integrate" ? !target.clean : !initial.clean) managedError("worktree_dirty");
    owner.registry.intent(input.requestId, tree.id, action, JSON.parse(expected));
    try {
      this.ports.audit(scope, action, "started", input.requestId);
      return await this.ports.exclusive(scope, paths, signal, async () => {
        await this.ports.assertIdle(scope, paths, signal);
        if (await this.ports.referenced(tree.path, signal)) managedError("worktree_bound", "busy");
        assertCurrent();
        let worktree = await owner.verify(tree, signal);
        let integration = await owner.git.inspect(member.integrationPath, signal);
        if (
          worktree.head !== initial.head ||
          integration.head !== target.head ||
          (action === "integrate" && !integration.clean)
        )
          managedError("worktree_stale");
        owner.registry.settle(input.requestId, "running");
        owner.state(member, "integrating");
        if (action === "integrate") {
          worktree = await commitGroupWorktree(local, owner.git, worktree, {
            ...dispatch,
            assertAuthorized: assertCurrent,
          });
          if (worktree.head !== integration.head)
            await owner.git.write(
              {
                kind: "integrate",
                source: worktree,
                target: integration,
                expectedSourceHead: worktree.head,
                expectedTargetHead: integration.head,
                allowMerge: true,
              },
              { ...dispatch, assertAuthorized: assertCurrent },
            );
          integration = await owner.git.inspect(member.integrationPath, signal);
          if (
            !(await owner.git.ancestor(
              integration.root.path,
              worktree.head,
              integration.head,
              signal,
            ))
          )
            managedError("worktree_interrupted");
        }
        const allocation = owner.registry.allocationForTree(tree.id);
        if (!allocation) managedError("worktree_allocation_stale");
        const parent = await managedIdentity(allocation.parentPath);
        if (
          parent.device !== allocation.identity.device ||
          parent.inode !== allocation.identity.inode
        )
          managedError("worktree_identity_changed");
        const removeAuthority = await this.ports.authorize(
          scope,
          "remove",
          [tree.path, tree.commonDir],
          signal,
        );
        const assertRemove = () => {
          removeAuthority.assertAuthorized();
          assertScope();
        };
        const removeSource = await owner.git.inspect(tree.sourcePath, signal);
        await owner.git.write(
          {
            kind: "remove",
            source: removeSource,
            worktree,
            managedId: tree.id,
            parent,
            ...(action === "integrate"
              ? { integratedInto: integration }
              : { preserveBranch: true }),
          },
          { ...dispatch, assertAuthorized: assertRemove },
        );
        transaction(local.deps.db, () => {
          owner.registry.update(tree.id, tree.version, {
            state: "removed",
            head: worktree.head,
            identity: tree.identity,
          });
          owner.state(member, action === "integrate" ? "integrated" : "removed");
          owner.registry.settle(input.requestId, "done");
          this.ports.audit(scope, action, "done", input.requestId);
        });
        this.ports.changed(scope);
        return view();
      });
    } catch (error) {
      throw preserveManagedFailure(error, [
        () => owner.registry.settle(input.requestId, "interrupted"),
        () => {
          const registry = owner.registry.get(tree.id),
            current = owner.repo.get(member.taskId);
          if (
            registry?.state === "ready" &&
            registry.version === tree.version &&
            current?.worktreeId === tree.id &&
            current.state !== "integrated" &&
            current.state !== "removed"
          )
            owner.state(
              current,
              "interrupted",
              action === "integrate"
                ? "group_workspace_integration_failed"
                : "group_workspace_cleanup_failed",
            );
        },
        () => this.ports.audit(scope, action, "error", input.requestId),
        () => this.ports.changed(scope),
      ]);
    }
  }
}
