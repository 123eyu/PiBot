import { AsyncLocalStorage } from "node:async_hooks";
import type {
  WorkspaceChat as ChatService,
  WorkspaceGroups as GroupService,
  WorkspaceLocal as LocalService,
  ToolRunContext,
  WorkspaceTopics as TopicWorkplaceService,
} from "@pibot/brain/kit";
import { BotsRepo, GroupsRepo } from "@pibot/storage";
import { type ChangesTarget, RpcError, type Run } from "@pibot/workspaces-contract/full";
import { WorktreeScmService } from "../changes/git/worktree-scm.ts";
import { FileCheckpointService } from "../changes/write/file-checkpoints.ts";
import type { GroupMemberWorktrees } from "../groups/group-member-worktrees.ts";
import { GroupTaskWorktreeActions } from "../groups/group-task-worktree-actions.ts";
import { captureDrainedRun } from "./managed-auto-checkpoints.ts";
import { ManagedBranchConfigurationService } from "./managed-config-authority.ts";
import { ManagedResourceAuthority } from "./managed-resource-authority.ts";
import { managedBinding } from "./managed-resource-binding.ts";
import { ManagedResourceLifecycle } from "./managed-resource-lifecycle.ts";
import { type ManagedResourcePorts, managedError } from "./managed-resource-ports.ts";
import { ManagedWorktreeService } from "./managed-worktrees.ts";

/** Narrow host/user adapters; model tools never receive the service or a general path capability. */
export function createManagedResources(
  local: LocalService,
  chat: ChatService,
  groups: GroupService,
  topics: TopicWorkplaceService,
  members: GroupMemberWorktrees,
) {
  const captures = new Map<string, Promise<void>>();
  const management = new AbortController();
  const shutdown = new AbortController(),
    pending = new Set<Promise<unknown>>();
  const lifecycle = new ManagedResourceLifecycle(local, chat, groups);
  const owner = new AsyncLocalStorage<string>();
  const authority = new ManagedResourceAuthority(local, lifecycle.revision);
  const ports: ManagedResourcePorts = {
    dataDir: local.deps.dataDir,
    target: local.target,
    snapshot: (operation, signal) =>
      local.changes.turn.withSnapshotLease?.(operation, signal) ?? operation(),
    snapshotBudget: local.changes.turn.snapshotBudget,
    execOptions: {
      platform: local.deps.platform,
      env: local.deps.env,
      systemHome: local.deps.userHome,
      tempDir: local.deps.tempDir,
      resourcesDir: local.deps.resourcesDir,
      proxy: local.deps.proxy,
      redactor: local.deps.redactor,
    },
    async scope(target, signal) {
      const scope = await local.changes.scope(target, signal);
      if (owner.getStore() !== undefined && owner.getStore() !== scope.botId)
        managedError("managed_source_changed");
      await authority.read(scope, signal);
      return scope;
    },
    authorize: (scope, action, paths, signal) => authority.authorize(scope, action, paths, signal),
    assertIdle: (scope, paths, signal) => lifecycle.assertIdle(scope, paths, signal),
    exclusive: (scope, paths, signal, operation) =>
      lifecycle.exclusive(scope, paths, signal, operation),
    bindRoot: managedBinding(local, groups, topics, lifecycle, authority),
    referenced: (path, signal) => lifecycle.referenced(path, signal),
    audit(scope, action, state, operationId) {
      local.approvals.audit.append({
        botId: scope.botId,
        kind: state === "started" ? "exec.started" : "exec.finished",
        summary: "Managed resource operation / 受管资源操作",
        detail: {
          toolName: `managed.${action}`,
          target: operationId,
          actor: "user",
          reasonCode: state,
          ...(scope.groupId ? { groupId: scope.groupId } : {}),
          ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
        },
      });
    },
    changed: (scope, runId) => {
      local.changes.forget(scope.root.path);
      local.changes.notify(scope);
      if (runId)
        local.deps.peer.emit("changes.changed", {
          conversationKey: scope.conversationKey,
          ...(scope.topicId ? { topicId: scope.topicId } : {}),
          runId,
          reason: "turn",
        });
    },
  };
  const worktrees = new ManagedWorktreeService(local.deps.db, ports),
    checkpoints = new FileCheckpointService(local.deps.db, ports);
  const configurations = new ManagedBranchConfigurationService(local, worktrees, lifecycle);
  const previousConfiguration = local.changes.managedConfiguration;
  local.changes.managedConfiguration = configurations;
  const groupTaskWorktrees = new GroupTaskWorktreeActions(groups, ports, members);
  const previousLayout = local.changes.managedLayout,
    previousLease = local.changes.userWriteLease;
  const owned = <T>(
    botId: string,
    parent: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
    timeoutMs = 180_000,
  ): Promise<T> => {
    const signal = AbortSignal.any([
      management.signal,
      local.shutdown.signal,
      AbortSignal.timeout(timeoutMs),
      ...(parent ? [parent] : []),
    ]);
    signal.throwIfAborted();
    // Both sides reserve synchronously before host/model awaits can interleave.
    const release = lifecycle.reserve(botId);
    const operation = owner.run(botId, async () => {
      try {
        return await action(signal);
      } finally {
        release();
      }
    });
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  const layout: NonNullable<typeof local.changes.managedLayout> = {
    allows: worktrees.managedLayout.allows,
    write: (scope, operations, signal) =>
      owned(scope.botId, signal, (bound) =>
        worktrees.managedLayout.write(scope, operations, bound),
      ),
  };
  local.changes.managedLayout = layout;
  const lease: NonNullable<typeof local.changes.userWriteLease> = (scope, signal, operation) =>
    owned(scope.botId, signal, async (bound) => {
      const permission = await authority.authorize(
        scope,
        "changes_write",
        [scope.root.path],
        bound,
      );
      return lifecycle.exclusive(scope, [scope.root.path], bound, async () => {
        permission.assertAuthorized();
        return operation(bound, permission.assertAuthorized);
      });
    });
  local.changes.userWriteLease = lease;
  const run = <T>(
    target: ChangesTarget,
    action: (signal: AbortSignal) => Promise<T>,
    timeoutMs = 180_000,
  ): Promise<T> => {
    const [kind, id] = target.conversationKey.split(":");
    const botId =
      kind === "group" ? new GroupsRepo(local.deps.db).get(id ?? "")?.coordinatorBotId : id;
    if (!botId || !new BotsRepo(local.deps.db).get(botId)) managedError("managed_source_changed");
    return owned(botId, undefined, action, timeoutMs);
  };
  let disposing: Promise<void> | undefined;
  return {
    quiesce: () => management.abort(),
    worktrees,
    scm: new WorktreeScmService(local, ports, chat),
    checkpoints,
    retry<T>(
      target: ChangesTarget,
      operation: (
        scope: import("../changes/changes-scope.ts").ChangesScope,
        signal: AbortSignal,
        files: { managed: boolean },
      ) => Promise<T>,
    ) {
      return run(target, async (signal) => {
        const scope = await local.changes.scope(target, signal);
        if (owner.getStore() !== undefined && owner.getStore() !== scope.botId)
          managedError("managed_source_changed");
        // A working folder Pi Bot may not manage (one inside a protected location such as
        // ~/.claude) still lets the conversation branch; only file restores need it, and the
        // caller refuses those (maintainers 2026-11-18: 小译's folder blocked retry with no files).
        const managed = await authority.read(scope, signal).then(
          () => true,
          (error: unknown) => {
            if (error instanceof RpcError && error.message === "managed_readonly_root")
              return false;
            throw error;
          },
        );
        return ports.exclusive(scope, [scope.primary.path], signal, async () => {
          await ports.assertIdle(scope, [scope.primary.path], signal);
          return operation(scope, signal, { managed });
        });
      });
    },
    groupTaskWorktrees,
    captureDrained(context: ToolRunContext | undefined, record: Run, observation: AbortSignal) {
      const previous = captures.get(record.id);
      if (previous) return previous;
      // Queue still owns the write lease; no management reserve/assertIdle or lock reacquisition.
      const signal = AbortSignal.any([observation, shutdown.signal, AbortSignal.timeout(120_000)]);
      const operation = captureDrainedRun(local, ports, context, record, signal);
      pending.add(operation);
      captures.set(record.id, operation);
      const release = () => {
        pending.delete(operation);
        captures.delete(record.id);
      };
      void operation.then(release, release);
      return operation;
    },
    run,
    assertBrowserAvailable: (botId: string) => lifecycle.assertBrowserAvailable(botId),
    beginBrowserTakeover: (botId: string) => lifecycle.beginBrowserTakeover(botId),
    allocate(target: ChangesTarget) {
      return run(target, (signal) => worktrees.allocate(target, signal));
    },
    dispose() {
      disposing ??= (async () => {
        management.abort();
        shutdown.abort();
        await Promise.allSettled([...pending]);
        const settled = await Promise.allSettled([
          configurations.dispose(),
          worktrees.dispose(),
          checkpoints.dispose(),
        ]);
        if (settled.some((result) => result.status === "rejected"))
          throw new Error("managed_cleanup_unconfirmed");
        lifecycle.dispose();
        // Releasing adapter hooks is allowed only after both services and actual leases certify drain.
        if (local.changes.managedConfiguration === configurations)
          local.changes.managedConfiguration = previousConfiguration;
        if (local.changes.managedLayout === layout) local.changes.managedLayout = previousLayout;
        if (local.changes.userWriteLease === lease) local.changes.userWriteLease = previousLease;
      })();
      return disposing;
    },
  };
}
export type ManagedResources = ReturnType<typeof createManagedResources>;
