import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createManagedGit,
  type GitWriteOperation,
  type ManagedGitRepository,
  managedIdentity,
  managedWorktreePath,
  prepareManagedProject,
} from "@pibot/execution";
import { type ManagedRecord, ManagedWorktreesRepo, transaction } from "@pibot/storage";
import {
  type ChangesTarget,
  type ManagedWorktree,
  ManagedWorktreeSchema,
} from "@pibot/workspaces-contract/full";
import {
  isManagedCleanupFailure,
  notifyManagedFailure,
  preserveManagedFailure,
} from "./managed-failure.ts";
import {
  type ManagedResourcePorts,
  managedError,
  managedScopeKey,
  primaryManagedScope,
} from "./managed-resource-ports.ts";
import { ManagedServiceLifetime } from "./managed-service-lifetime.ts";

/** The registry is a capability issuer, not permission to make an arbitrary external .git writable. */
export class ManagedWorktreeService {
  readonly repo: ManagedWorktreesRepo;
  private readonly lifetime = new ManagedServiceLifetime();
  readonly git: ReturnType<typeof createManagedGit>;
  private readonly writing = new Set<string>();
  readonly managedLayout = {
    allows: async (
      scope: Awaited<ReturnType<ManagedResourcePorts["scope"]>>,
      signal: AbortSignal,
    ) =>
      this.lifetime.run(signal, async (signal) => {
        if (
          this.ports.execOptions.platform !== "darwin" ||
          scope.nestedReadonly ||
          scope.root.role !== "primary"
        )
          return false;
        const value = this.repo.byPath(scope.root.path);
        if (
          !value ||
          value.botId !== scope.botId ||
          !this.repo.bindings(value.id).includes(managedScopeKey(scope))
        )
          return false;
        try {
          await this.verify(value, signal);
          return true;
        } catch (error) {
          if (signal.aborted) throw error;
          return false;
        }
      }),
    write: async (
      scope: Awaited<ReturnType<ManagedResourcePorts["scope"]>>,
      operations: GitWriteOperation[],
      signal: AbortSignal,
    ) =>
      this.lifetime.run(signal, async (signal) => {
        primaryManagedScope(scope);
        if (!(await this.managedLayout.allows(scope, signal)))
          managedError("worktree_binding_required");
        const value = this.repo.byPath(scope.root.path) as ManagedRecord,
          repository = await this.verify(value, signal);
        const authority = await this.ports.authorize(
          scope,
          "changes_write",
          [value.path, value.commonDir],
          signal,
        );
        const key = `${repository.common.device}:${repository.common.inode}`;
        if (this.writing.has(key)) managedError("worktree_busy", "busy");
        this.writing.add(key);
        let uncertain = false;
        try {
          return await this.ports.exclusive(scope, [value.path], signal, async () => {
            await this.ports.assertIdle(scope, [value.path], signal);
            const result = await this.git.writeChanges(repository, operations, {
              ...authority,
              home: scope.home,
              dataDir: this.ports.dataDir,
              signal,
            });
            const after = await this.git.inspect(value.path, signal);
            this.repo.update(value.id, value.version, { ...value, head: after.head });
            return result;
          });
        } catch (error) {
          uncertain =
            !!error &&
            typeof error === "object" &&
            "reason" in error &&
            error.reason === "cleanup_failed";
          throw error;
        } finally {
          if (!uncertain) this.writing.delete(key);
        }
      }),
  };
  constructor(
    private readonly db: DatabaseSync,
    private readonly ports: ManagedResourcePorts,
  ) {
    this.repo = new ManagedWorktreesRepo(db);
    this.git = createManagedGit(ports.execOptions);
  }
  private view(
    value: ManagedRecord,
    live?: { clean: boolean; sourceHead: string; sourceClean: boolean },
  ): ManagedWorktree {
    return ManagedWorktreeSchema.strip().parse({ ...value, ...live });
  }
  private owned(id: string, botId: string, version?: number) {
    const value = this.repo.get(id);
    if (
      !value ||
      this.repo.taskOwned(id) ||
      value.botId !== botId ||
      value.state !== "ready" ||
      (version !== undefined && value.version !== version)
    )
      managedError("worktree_stale");
    return value;
  }
  private async verify(value: ManagedRecord, signal: AbortSignal) {
    if (!value.identity) managedError("worktree_interrupted");
    const current = await this.git.inspect(value.path, signal);
    for (const key of ["root", "git", "common"] as const) {
      const expected = value.identity[key],
        now = current[key];
      if (
        now.path !== expected.path ||
        now.device !== expected.device ||
        now.inode !== expected.inode
      )
        managedError("worktree_identity_changed");
    }
    if (current.common.path !== value.commonDir || current.branch !== `refs/heads/${value.branch}`)
      managedError("worktree_identity_changed");
    return current;
  }
  private async listInternal(
    target: ChangesTarget,
    limit = 20,
    before?: string,
    signal = AbortSignal.timeout(30_000),
  ) {
    const scope = await this.ports.scope(target, signal);
    const current = this.repo.byPath(scope.root.path);
    if (
      current &&
      (current.botId !== scope.botId ||
        !this.repo.bindings(current.id).includes(managedScopeKey(scope)))
    )
      managedError("worktree_source_scope");
    const sourcePath = current?.sourcePath ?? scope.root.path;
    const permission = await this.ports.authorize(scope, "inspect", [sourcePath], signal);
    const source = await this.git.inspect(sourcePath, signal);
    permission.assertAuthorized();
    const rows = this.repo.listForScope(
      scope.botId,
      sourcePath,
      scope.groupId,
      scope.conversationId,
      limit,
      before,
    );
    const visible = await Promise.all(
      rows.slice(0, limit).map(async (row) => {
        if (row.state !== "ready") return this.view(row);
        try {
          const live = await this.verify(row, signal);
          const destination = row.integrationPath
            ? await this.git.inspect(row.integrationPath, signal)
            : source;
          if (
            source.root.device !== row.sourceIdentity.device ||
            source.root.inode !== row.sourceIdentity.inode ||
            source.common.path !== live.common.path ||
            destination.common.path !== live.common.path
          )
            managedError("worktree_identity_changed");
          permission.assertAuthorized();
          return this.view(
            { ...row, head: live.head },
            { clean: live.clean, sourceHead: destination.head, sourceClean: destination.clean },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          return this.view({ ...row, state: "interrupted" });
        }
      }),
    );
    permission.assertAuthorized();
    return {
      items: visible,
      nextBefore: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }
  private async allocateInternal(target: ChangesTarget, signal: AbortSignal) {
    const scope = await this.ports.scope(target, signal);
    const primary = primaryManagedScope(scope);
    if (this.ports.execOptions.platform !== "darwin")
      managedError("managed_platform_unsupported", "unsupported");
    const source = await this.git.inspect(primary.path, signal);
    if (
      source.root.device !== primary.device ||
      source.root.inode !== primary.inode ||
      source.git.path !== join(primary.path, ".git") ||
      source.common.path !== source.git.path
    )
      managedError("worktree_stale");
    if (this.repo.count(source.common.path) >= 8) managedError("worktree_quota");
    const parentPath = join(primary.path, ".pibot", "wt");
    const authority = await this.ports.authorize(
      scope,
      "allocate",
      [parentPath, join(source.git.path, "info", "exclude")],
      signal,
    );
    const key = `${source.common.device}:${source.common.inode}`,
      id = randomUUID();
    if (this.writing.has(key)) managedError("worktree_busy", "busy");
    this.writing.add(key);
    let failure: unknown;
    try {
      this.ports.audit(scope, "allocate", "started", id);
      return await this.ports.exclusive(scope, [primary.path], signal, async () => {
        await this.ports.assertIdle(scope, [primary.path], signal);
        const identity = await prepareManagedProject(
          source.root,
          signal,
          authority.assertAuthorized,
          source.git,
        );
        authority.assertAuthorized();
        const value = {
          id,
          botId: scope.botId,
          scopeKey: managedScopeKey(scope),
          parentPath,
          identity,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        };
        this.repo.allocate(value);
        this.ports.audit(scope, "allocate", "done", id);
        return { id: value.id, parentPath, expiresAt: value.expiresAt };
      });
    } catch (error) {
      failure = preserveManagedFailure(error, [
        () => this.ports.audit(scope, "allocate", "error", id),
      ]);
      throw failure;
    } finally {
      if (!isManagedCleanupFailure(failure)) this.writing.delete(key);
      notifyManagedFailure(failure, () => this.ports.changed(scope));
    }
  }
  private async createInternal(
    input: {
      target: ChangesTarget;
      allocationId: string;
      requestId: string;
      expectedSourceHead: string;
    },
    signal: AbortSignal,
  ) {
    const scope = await this.ports.scope(input.target, signal);
    const primary = primaryManagedScope(scope);
    const duplicate = this.repo.request(input.requestId);
    if (duplicate) {
      if (duplicate.botId !== scope.botId || duplicate.sourcePath !== primary.path)
        managedError("worktree_request_conflict");
      return this.view(duplicate);
    }
    const allocation = this.repo.allocation(input.allocationId);
    if (
      !allocation ||
      allocation.botId !== scope.botId ||
      allocation.scopeKey !== managedScopeKey(scope) ||
      allocation.parentPath !== join(primary.path, ".pibot", "wt") ||
      allocation.consumedBy ||
      allocation.expiresAt <= new Date().toISOString()
    )
      managedError("worktree_binding_required");
    const source = await this.git.inspect(primary.path, signal);
    if (
      source.root.device !== primary.device ||
      source.root.inode !== primary.inode ||
      source.git.path !== join(primary.path, ".git") ||
      source.common.path !== source.git.path ||
      source.head !== input.expectedSourceHead
    )
      managedError("worktree_stale");
    if (this.repo.count(source.common.path) >= 8) managedError("worktree_quota");
    const id = randomUUID(),
      path = managedWorktreePath(allocation.parentPath, primary.path, id);
    const authority = await this.ports.authorize(
      scope,
      "create",
      [primary.path, path, source.common.path],
      signal,
    );
    const now = new Date().toISOString();
    let value: ManagedRecord = {
      id,
      botId: scope.botId,
      sourcePath: primary.path,
      path,
      commonDir: source.common.path,
      branch: `pibot/worktrees/${id}`,
      baseHead: source.head,
      head: null,
      sourceIdentity: source.root,
      identity: null,
      state: "creating",
      version: 1,
      requestId: input.requestId,
      createdAt: now,
      updatedAt: now,
      bindingRequired: true,
    };
    transaction(this.db, () => {
      this.repo.create(value, input.allocationId);
      this.repo.intent(input.requestId, id, "create", {
        sourceHead: source.head,
        parent: allocation.identity,
        path,
      });
    });
    return this.perform(
      scope,
      source,
      [primary.path, path],
      "create",
      input.requestId,
      signal,
      async () => {
        await this.git.write(
          {
            kind: "create",
            source,
            parent: allocation.identity,
            destination: path,
            managedId: id,
            baseHead: source.head,
          },
          { ...authority, home: scope.home, dataDir: this.ports.dataDir, signal },
        );
        const current = await this.git.inspect(path, signal);
        value = this.repo.update(id, value.version, {
          state: "ready",
          head: current.head,
          identity: { root: current.root, git: current.git, common: current.common },
        });
        return this.view(value);
      },
      () => {
        const current = this.repo.get(id);
        if (current && current.state !== "ready")
          this.repo.update(id, current.version, { ...current, state: "interrupted" });
      },
    );
  }
  private async bindInternal(
    input: { target: ChangesTarget; id: string; expectedVersion: number },
    signal: AbortSignal,
  ) {
    const scope = await this.ports.scope(input.target, signal);
    primaryManagedScope(scope);
    if (scope.conversationKey.startsWith("dm:") && !scope.topicId)
      managedError("worktree_topic_required");
    const value = this.owned(input.id, scope.botId, input.expectedVersion);
    const authority = await this.ports.authorize(scope, "bind", [value.path], signal);
    await this.ports.exclusive(scope, [scope.primary.path, value.path], signal, async () => {
      await this.ports.assertIdle(scope, [scope.primary.path, value.path], signal);
      const current = await this.verify(this.owned(value.id, scope.botId, value.version), signal);
      authority.assertAuthorized();
      await this.ports.bindRoot(
        scope,
        value,
        () => this.repo.bind(managedScopeKey(scope), scope.botId, value.id, current.root),
        signal,
      );
    });
    this.ports.changed(scope);
    return { ok: true as const };
  }
  private async recoverInternal(target: ChangesTarget, id: string, signal: AbortSignal) {
    const scope = await this.ports.scope(target, signal);
    primaryManagedScope(scope);
    const value = this.repo.get(id);
    if (
      !value ||
      this.repo.taskOwned(id) ||
      value.botId !== scope.botId ||
      value.sourcePath !== scope.primary.path ||
      value.state === "removed"
    )
      managedError("worktree_stale");
    const allocation = this.repo.allocationForTree(id);
    if (!allocation) managedError("worktree_allocation_stale");
    const authority = await this.ports.authorize(
      scope,
      "create",
      [value.path, value.commonDir],
      signal,
    );
    await this.ports.assertIdle(scope, [value.sourcePath, value.path], signal);
    if (!value.identity) {
      try {
        await lstat(value.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          managedError("worktree_creation_missing");
        throw error;
      }
    }
    const source = await this.git.inspect(value.sourcePath, signal),
      parent = await managedIdentity(allocation.parentPath),
      current = await this.git.inspect(value.path, signal);
    if (
      source.root.device !== value.sourceIdentity.device ||
      source.root.inode !== value.sourceIdentity.inode ||
      parent.device !== allocation.identity.device ||
      parent.inode !== allocation.identity.inode ||
      current.common.path !== value.commonDir ||
      current.branch !== `refs/heads/${value.branch}` ||
      !(await this.git.ownsLock(source.root.path, value.path, id, signal))
    )
      managedError("worktree_recovery_unavailable");
    if (value.identity) await this.verify(value, signal);
    else if (!current.clean || current.head !== value.baseHead)
      managedError("worktree_recovery_unavailable");
    authority.assertAuthorized();
    return this.view(
      this.repo.update(id, value.version, {
        state: "ready",
        head: current.head,
        identity: { root: current.root, git: current.git, common: current.common },
      }),
    );
  }
  private async integrateInternal(
    input: {
      target: ChangesTarget;
      id: string;
      requestId: string;
      expectedVersion: number;
      expectedTargetHead: string;
      expectedWorktreeHead: string;
    },
    signal: AbortSignal,
  ) {
    const scope = await this.ports.scope(input.target, signal);
    const primary = primaryManagedScope(scope);
    const value = this.owned(input.id, scope.botId, input.expectedVersion);
    let current: ManagedRecord | undefined;
    if (primary.path !== value.sourcePath) {
      current = this.repo.byPath(primary.path);
      if (
        !current ||
        current.botId !== scope.botId ||
        current.sourcePath !== value.sourcePath ||
        !this.repo.bindings(current.id).includes(managedScopeKey(scope))
      )
        managedError("worktree_source_scope");
    }
    const read = await this.ports.authorize(
      scope,
      "inspect",
      [value.path, value.sourcePath],
      signal,
    );
    const source = await this.verify(value, signal),
      target = await this.git.inspect(value.sourcePath, signal);
    read.assertAuthorized();
    if (current) {
      const bound = await this.verify(current, signal);
      if (
        bound.root.device !== primary.device ||
        bound.root.inode !== primary.inode ||
        bound.common.path !== target.common.path
      )
        managedError("worktree_identity_changed");
    }
    if (
      target.root.device !== value.sourceIdentity.device ||
      target.root.inode !== value.sourceIdentity.inode
    )
      managedError("worktree_identity_changed");
    if (
      target.root.path !== value.sourcePath ||
      target.common.path !== source.common.path ||
      source.head !== input.expectedWorktreeHead ||
      target.head !== input.expectedTargetHead
    )
      managedError("worktree_stale");
    if (!source.clean || !target.clean) managedError("worktree_dirty");
    if (!(await this.git.ancestor(target.root.path, target.head, source.head, signal)))
      managedError("worktree_diverged");
    const authority = await this.ports.authorize(
      scope,
      "integrate",
      [source.root.path, target.root.path, target.common.path],
      signal,
    );
    const duplicate = this.repo.operation(input.requestId);
    if (duplicate) {
      if (duplicate.worktreeId !== value.id || duplicate.kind !== "integrate")
        managedError("worktree_request_conflict");
      return this.view(value);
    }
    this.repo.intent(input.requestId, value.id, "integrate", {
      targetHead: target.head,
      worktreeHead: source.head,
    });
    return this.perform(
      scope,
      target,
      [target.root.path, source.root.path],
      "integrate",
      input.requestId,
      signal,
      async () => {
        await this.git.write(
          {
            kind: "integrate",
            source,
            target,
            expectedSourceHead: source.head,
            expectedTargetHead: target.head,
          },
          { ...authority, home: scope.home, dataDir: this.ports.dataDir, signal },
        );
        const observed = await this.git.inspect(target.root.path, signal);
        if (observed.head !== source.head) managedError("worktree_interrupted");
        return this.view(
          this.repo.update(value.id, value.version, {
            ...value,
            head: source.head,
            state: "ready",
          }),
        );
      },
    );
  }
  private async removeInternal(
    input: { target: ChangesTarget; id: string; requestId: string; expectedVersion: number },
    signal: AbortSignal,
  ) {
    const scope = await this.ports.scope(input.target, signal);
    primaryManagedScope(scope);
    const value = this.owned(input.id, scope.botId, input.expectedVersion);
    if (
      scope.primary.path !== value.sourcePath ||
      this.repo.bindings(value.id).length ||
      (await this.ports.referenced(value.path, signal))
    )
      managedError("worktree_bound", "busy");
    const source = await this.git.inspect(value.sourcePath, signal),
      worktree = await this.verify(value, signal);
    const allocation = this.repo.allocationForTree(value.id);
    if (!allocation) managedError("worktree_allocation_stale");
    if (!worktree.clean) managedError("worktree_dirty");
    const authority = await this.ports.authorize(
      scope,
      "remove",
      [value.path, source.common.path],
      signal,
    );
    this.repo.intent(input.requestId, value.id, "remove", { head: worktree.head });
    return this.perform(
      scope,
      source,
      [source.root.path, value.path],
      "remove",
      input.requestId,
      signal,
      async () => {
        if (await this.ports.referenced(value.path, signal)) managedError("worktree_bound", "busy");
        await this.git.write(
          {
            kind: "remove",
            source,
            worktree,
            managedId: value.id,
            parent: allocation.identity,
            preserveBranch: true,
          },
          { ...authority, home: scope.home, dataDir: this.ports.dataDir, signal },
        );
        return this.view(this.repo.update(value.id, value.version, { ...value, state: "removed" }));
      },
    );
  }
  private async perform<T>(
    scope: Awaited<ReturnType<ManagedResourcePorts["scope"]>>,
    repo: ManagedGitRepository,
    paths: string[],
    action: "create" | "integrate" | "remove",
    id: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
    failed?: () => void,
  ) {
    const key = `${repo.common.device}:${repo.common.inode}`;
    if (this.writing.has(key)) managedError("worktree_busy", "busy");
    this.writing.add(key);
    let uncertain = false;
    let failure: unknown;
    try {
      this.ports.audit(scope, action, "started", id);
      return await this.ports.exclusive(scope, paths, signal, async () => {
        await this.ports.assertIdle(scope, paths, signal);
        this.repo.settle(id, "running");
        const value = await operation();
        this.repo.settle(id, "done");
        this.ports.audit(scope, action, "done", id);
        return value;
      });
    } catch (error) {
      uncertain = isManagedCleanupFailure(error);
      failure = preserveManagedFailure(error, [
        () => this.repo.settle(id, "interrupted"),
        () => failed?.(),
        () => this.ports.audit(scope, action, "error", id),
      ]);
      throw failure;
    } finally {
      if (!uncertain) this.writing.delete(key);
      notifyManagedFailure(failure, () => this.ports.changed(scope));
    }
  }
  list(target: ChangesTarget, limit = 20, before?: string, signal = AbortSignal.timeout(30_000)) {
    return this.lifetime.run(signal, (active) => this.listInternal(target, limit, before, active));
  }
  allocate(target: ChangesTarget, signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.allocateInternal(target, active));
  }
  create(input: Parameters<ManagedWorktreeService["createInternal"]>[0], signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.createInternal(input, active));
  }
  bind(input: Parameters<ManagedWorktreeService["bindInternal"]>[0], signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.bindInternal(input, active));
  }
  recover(target: ChangesTarget, id: string, signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.recoverInternal(target, id, active));
  }
  integrate(
    input: Parameters<ManagedWorktreeService["integrateInternal"]>[0],
    signal: AbortSignal,
  ) {
    return this.lifetime.run(signal, async (active) => {
      const integrated = await this.integrateInternal(input, active);
      const target: ChangesTarget = {
        conversationKey: input.target.conversationKey,
        ...(input.target.topicId ? { topicId: input.target.topicId } : {}),
      };
      try {
        const scope = await this.ports.scope(target, active);
        const tree = this.owned(integrated.id, scope.botId, integrated.version);
        await this.ports.bindRoot(
          scope,
          tree,
          () => this.repo.unbind(managedScopeKey(scope)),
          active,
          true,
        );
        this.ports.changed(scope);
      } catch (error) {
        if (isManagedCleanupFailure(error) || active.aborted) throw error;
        managedError("worktree_integrated_binding_pending");
      }
      try {
        return await this.removeInternal(
          {
            target,
            id: integrated.id,
            requestId: randomUUID(),
            expectedVersion: integrated.version,
          },
          active,
        );
      } catch (error) {
        if (isManagedCleanupFailure(error) || active.aborted) throw error;
        managedError("worktree_integrated_cleanup_pending");
      }
    });
  }
  remove(input: Parameters<ManagedWorktreeService["removeInternal"]>[0], signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.removeInternal(input, active));
  }
  async dispose() {
    try {
      await this.lifetime.dispose();
    } finally {
      this.git.dispose();
    }
  }
}
