import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { prepareCheckpointRecovery, restoreCheckpointFile } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { type CheckpointRecord, FileCheckpointsRepo } from "@pibot/storage";
import {
  type ChangesTarget,
  FileCheckpointSchema,
  type FileRestore,
} from "@pibot/workspaces-contract/full";
import {
  isManagedCleanupFailure,
  notifyManagedFailure,
  preserveManagedFailure,
} from "../../managed/managed-failure.ts";
import {
  type ManagedResourcePorts,
  managedError,
  managedScopeKey,
  writableManagedScope,
} from "../../managed/managed-resource-ports.ts";
import { ManagedServiceLifetime } from "../../managed/managed-service-lifetime.ts";

/** File snapshots are separate from AF6's execution cursor and never pretend to undo commands. */
export class FileCheckpointService {
  readonly repo: FileCheckpointsRepo;
  private readonly lifetime = new ManagedServiceLifetime();
  private readonly changing = new Set<string>();
  constructor(
    db: DatabaseSync,
    private readonly ports: ManagedResourcePorts,
  ) {
    this.repo = new FileCheckpointsRepo(db);
  }
  private view(value: CheckpointRecord) {
    return FileCheckpointSchema.strip().parse(value);
  }
  private directory(botId: string, id: string) {
    return join(this.ports.dataDir, "bots", botId, "file-checkpoints", id);
  }
  private journal(value: CheckpointRecord, restoreId: string, itemId: string) {
    return join(this.directory(value.botId, value.id), "restores", restoreId, `${itemId}.jsonl`);
  }
  private selectRoot(
    scope: Awaited<ReturnType<ManagedResourcePorts["scope"]>>,
    root: Awaited<ReturnType<ManagedResourcePorts["scope"]>>["root"],
  ) {
    const platform = this.ports.execOptions.platform;
    if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
      managedError("checkpoint_platform_unsupported", "unsupported");
    scope.root = root;
    // The previous selection's overlap says nothing about this root's write authority.
    scope.nestedReadonly =
      scope.boundaryConflict ||
      scope.roots.some(
        (other) =>
          other.role === "readonly" &&
          other.path !== scope.readonlySource &&
          (containsPath(root.path, other.path, platform) ||
            containsPath(other.path, root.path, platform)),
      );
  }
  private owned(id: string, scope: Awaited<ReturnType<ManagedResourcePorts["scope"]>>) {
    const value = this.repo.get(id);
    const actual = scope.roots.find(
      (root) => root.path === value?.root && root.role !== "readonly",
    );
    if (actual) this.selectRoot(scope, actual);
    if (
      !value ||
      (!scope.groupId && value.botId !== scope.botId) ||
      value.scopeKey !== managedScopeKey(scope) ||
      value.root !== scope.root.path
    )
      managedError("checkpoint_unknown");
    const primary = writableManagedScope(scope);
    if (value.identity.device !== primary.device || value.identity.inode !== primary.inode)
      managedError("checkpoint_root_changed");
    return value;
  }
  private async forRunInternal(target: ChangesTarget, runId: string, signal: AbortSignal) {
    const scope = await this.ports.scope(target, signal);
    // A read-only folder overlapping the primary means nothing here can be restored (restores
    // still refuse with managed_readonly_root). Listing nothing lets the panel say "view only";
    // throwing showed a generic "operation not completed" error on every open (maintainers 2026-11-15).
    if (scope.boundaryConflict) return [];
    const records = [];
    for (const root of scope.roots) {
      signal.throwIfAborted();
      if (root.role === "readonly") continue;
      const selected = { ...scope };
      this.selectRoot(selected, root);
      if (selected.nestedReadonly) continue;
      const record = this.repo.forRun(runId, root.path);
      if (!record) continue;
      const { items: _, ...summary } = this.view(this.owned(record.id, selected));
      records.push({ ...summary, rootId: root.id });
    }
    return records;
  }
  private async createInternal(target: ChangesTarget, runId: string, signal: AbortSignal) {
    const scope = await this.ports.scope(target, signal);
    const value = this.repo.forRun(runId, scope.root.path);
    if (!value) managedError("checkpoint_automatic_only");
    return this.view(this.owned(value.id, scope));
  }
  private async listInternal(
    target: ChangesTarget,
    limit = 20,
    before?: string,
    signal = AbortSignal.timeout(30_000),
  ) {
    const scope = await this.ports.scope(target, signal);
    writableManagedScope(scope);
    const rows = this.repo.list(
      scope.groupId ? null : scope.botId,
      managedScopeKey(scope),
      scope.root.path,
      limit,
      before,
    );
    return {
      items: rows.slice(0, limit).map((row) => {
        const { items: _, ...summary } = this.view(row);
        return summary;
      }),
      nextBefore: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }
  private async getInternal(target: ChangesTarget, id: string, signal: AbortSignal) {
    const scope = await this.ports.scope(target, signal);
    return this.view(this.owned(id, scope));
  }
  private async restoreInternal(
    input: {
      target: ChangesTarget;
      id: string;
      requestId: string;
      expectedVersion: number;
      itemIds: string[];
    },
    signal: AbortSignal,
  ) {
    const scope = await this.ports.scope(input.target, signal),
      value = this.owned(input.id, scope);
    if (value.version !== input.expectedVersion || value.state === "expired")
      managedError("checkpoint_stale");
    const ids = new Set(input.itemIds);
    if (ids.size !== input.itemIds.length || !ids.size)
      managedError("checkpoint_invalid_selection");
    const items = value.items.filter((item) => ids.has(item.id));
    if (items.length !== ids.size || items.some((item) => !item.restorable))
      managedError("checkpoint_unsupported");
    const duplicate = this.repo.restore(input.requestId);
    if (duplicate) {
      if (
        duplicate.checkpointId !== value.id ||
        duplicate.items.length !== ids.size ||
        duplicate.items.some((item) => !ids.has(item.itemId))
      )
        managedError("checkpoint_request_conflict");
      return duplicate;
    }
    const authority = await this.ports.authorize(
      scope,
      "checkpoint_restore",
      items.map((item) => item.path),
      signal,
    );
    const key = `${value.identity.device}:${value.identity.inode}`;
    if (this.changing.has(key)) managedError("checkpoint_busy", "busy");
    this.changing.add(key);
    const recoveryPath = join(
        this.directory(value.botId, value.id),
        "restores",
        input.requestId,
        "files",
      ),
      now = new Date().toISOString();
    const operation: FileRestore = {
      id: input.requestId,
      checkpointId: value.id,
      state: "intent",
      recoveryPath,
      items: items.map((item) => ({ itemId: item.id, state: "pending" })),
      createdAt: now,
      updatedAt: now,
    };
    let uncertain = false;
    let failure: unknown;
    try {
      this.repo.intent(operation);
      this.ports.audit(scope, "checkpoint_restore", "started", operation.id);
      await this.ports.exclusive(scope, [value.root], signal, async () => {
        await this.ports.assertIdle(scope, [value.root], signal);
        authority.assertAuthorized();
        const journals = join(this.directory(value.botId, value.id), "restores", operation.id);
        await mkdir(journals, { recursive: true, mode: 0o700 });
        for (const item of items)
          await writeFile(this.journal(value, operation.id, item.id), '{"phase":"intent"}\n', {
            flag: "wx",
            mode: 0o600,
          });
        await prepareCheckpointRecovery(this.ports.execOptions, {
          root: value.identity,
          checkpointId: value.id,
          restoreId: operation.id,
          itemIds: items.map((item) => item.id),
          ...authority,
          home: join(this.ports.dataDir, "bots", value.botId, "home"),
          dataDir: this.ports.dataDir,
          signal,
        });
        this.repo.settle(operation.id, "running");
        for (const item of items) {
          signal.throwIfAborted();
          authority.assertAuthorized();
          const image = value.images.get(item.id);
          if (!image?.after) managedError("checkpoint_snapshot_missing");
          const recovery = join(recoveryPath, item.id);
          const result = await restoreCheckpointFile(this.ports.execOptions, {
            root: value.identity,
            target: item.path,
            recovery,
            journal: this.journal(value, operation.id, item.id),
            before: image.before,
            after: image.after,
            blob: image.before
              ? join(this.directory(value.botId, value.id), image.before.blob)
              : null,
            ...authority,
            home: join(this.ports.dataDir, "bots", value.botId, "home"),
            dataDir: this.ports.dataDir,
            cwd: value.root,
            signal,
          });
          this.repo.item(operation.id, item.id, result.state, result.reason);
          // A content conflict is local to this item. Cancellation and uncertain cleanup throw.
          if (result.state === "interrupted") {
            this.repo.finishPending(operation.id);
            this.repo.settle(operation.id, "interrupted");
            return;
          }
        }
        const settled = this.repo.restore(operation.id) as FileRestore;
        this.repo.settle(
          operation.id,
          settled.items.every((item) => item.state === "restored") ? "done" : "conflict",
        );
      });
      const receipt = this.repo.restore(operation.id) as FileRestore;
      this.ports.audit(
        scope,
        "checkpoint_restore",
        receipt.state === "done" ? "done" : "error",
        operation.id,
      );
      return this.repo.restore(operation.id) as FileRestore;
    } catch (error) {
      uncertain = isManagedCleanupFailure(error);
      failure = preserveManagedFailure(error, [
        () => this.repo.finishPending(operation.id),
        () => this.repo.settle(operation.id, "interrupted"),
        () => this.ports.audit(scope, "checkpoint_restore", "error", operation.id),
      ]);
      throw failure;
    } finally {
      if (!uncertain) this.changing.delete(key);
      notifyManagedFailure(failure, () => this.ports.changed(scope, value.runId));
    }
  }
  /** Only inspect journal/target evidence after a crash. No implicit retry of rename or link. */
  private async recoverInternal(target: ChangesTarget, restoreId: string, signal: AbortSignal) {
    const scope = await this.ports.scope(target, signal),
      operation = this.repo.restore(restoreId);
    if (!operation) managedError("checkpoint_unknown");
    const value = this.owned(operation.checkpointId, scope);
    if (operation.state === "done" || operation.state === "conflict") return operation;
    if (this.changing.has(`${value.identity.device}:${value.identity.inode}`))
      managedError("checkpoint_busy", "busy");
    const authority = await this.ports.authorize(
      scope,
      "checkpoint_create",
      value.items
        .filter((item) => operation.items.some((selected) => selected.itemId === item.id))
        .map((item) => item.path),
      signal,
    );
    let failure: unknown;
    try {
      for (const selected of operation.items) {
        if (selected.state === "restored") continue;
        const item = value.items.find((item) => item.id === selected.itemId),
          image = value.images.get(selected.itemId);
        if (!item || !image?.after) continue;
        const recovery = join(operation.recoveryPath, item.id);
        try {
          await lstat(recovery);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            this.repo.item(operation.id, item.id, "interrupted");
            continue;
          }
          throw error;
        }
        const result = await restoreCheckpointFile(this.ports.execOptions, {
          ...authority,
          home: join(this.ports.dataDir, "bots", value.botId, "home"),
          dataDir: this.ports.dataDir,
          cwd: value.root,
          signal,
          root: value.identity,
          target: item.path,
          recovery,
          journal: this.journal(value, operation.id, item.id),
          before: image.before,
          after: image.after,
          blob: null,
          reconcile: true,
        });
        this.repo.item(operation.id, item.id, result.state, result.reason);
      }
      const current = this.repo.restore(operation.id) as FileRestore;
      this.repo.settle(
        operation.id,
        current.items.every((item) => item.state === "restored") ? "done" : "interrupted",
      );
      return this.repo.restore(operation.id) as FileRestore;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      notifyManagedFailure(failure, () => this.ports.changed(scope, value.runId));
    }
  }
  private async restoresInternal(
    target: ChangesTarget,
    id: string,
    limit = 10,
    before?: string,
    signal = AbortSignal.timeout(30_000),
  ) {
    const scope = await this.ports.scope(target, signal);
    this.owned(id, scope);
    const rows = this.repo.restores(id, limit, before);
    return {
      items: rows.slice(0, limit),
      nextBefore: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }
  /** Explicit continuation only, using the private journal and the retained original inode. */
  private async resumeInternal(target: ChangesTarget, restoreId: string, signal: AbortSignal) {
    const scope = await this.ports.scope(target, signal),
      operation = this.repo.restore(restoreId);
    if (!operation) managedError("checkpoint_unknown");
    const value = this.owned(operation.checkpointId, scope);
    if (operation.state === "done" || operation.state === "conflict") return operation;
    const items = operation.items
      .filter((item) => item.state !== "restored")
      .map((selected) => value.items.find((item) => item.id === selected.itemId));
    if (items.some((item) => !item?.restorable)) managedError("checkpoint_unsupported");
    const selected = items.filter((item) => item !== undefined);
    const authority = await this.ports.authorize(
      scope,
      "checkpoint_restore",
      selected.map((item) => item.path),
      signal,
    );
    const key = `${value.identity.device}:${value.identity.inode}`;
    if (this.changing.has(key)) managedError("checkpoint_busy", "busy");
    this.changing.add(key);
    let uncertain = false;
    let failure: unknown;
    try {
      this.ports.audit(scope, "checkpoint_restore", "started", operation.id);
      await this.ports.exclusive(scope, [value.root], signal, async () => {
        await this.ports.assertIdle(scope, [value.root], signal);
        authority.assertAuthorized();
        this.repo.settle(operation.id, "running");
        for (const item of selected) {
          const image = value.images.get(item.id);
          if (!image?.after) managedError("checkpoint_snapshot_missing");
          const recovery = join(operation.recoveryPath, item.id);
          const result = await restoreCheckpointFile(this.ports.execOptions, {
            ...authority,
            home: join(this.ports.dataDir, "bots", value.botId, "home"),
            dataDir: this.ports.dataDir,
            cwd: value.root,
            signal,
            root: value.identity,
            target: item.path,
            recovery,
            journal: this.journal(value, operation.id, item.id),
            before: image.before,
            after: image.after,
            blob: image.before
              ? join(this.directory(value.botId, value.id), image.before.blob)
              : null,
            resume: true,
          });
          this.repo.item(operation.id, item.id, result.state, result.reason);
          // A content conflict is local to this item. Cancellation and uncertain cleanup throw.
          if (result.state === "interrupted") {
            this.repo.finishPending(operation.id);
            this.repo.settle(operation.id, "interrupted");
            return;
          }
        }
        const settled = this.repo.restore(operation.id) as FileRestore;
        this.repo.settle(
          operation.id,
          settled.items.every((item) => item.state === "restored") ? "done" : "conflict",
        );
      });
      const receipt = this.repo.restore(operation.id) as FileRestore;
      this.ports.audit(
        scope,
        "checkpoint_restore",
        receipt.state === "done" ? "done" : "error",
        operation.id,
      );
      return this.repo.restore(operation.id) as FileRestore;
    } catch (error) {
      uncertain = isManagedCleanupFailure(error);
      failure = preserveManagedFailure(error, [
        () => this.repo.finishPending(operation.id),
        () => this.repo.settle(operation.id, "interrupted"),
        () => this.ports.audit(scope, "checkpoint_restore", "error", operation.id),
      ]);
      throw failure;
    } finally {
      if (!uncertain) this.changing.delete(key);
      notifyManagedFailure(failure, () => this.ports.changed(scope, value.runId));
    }
  }
  forRun(target: ChangesTarget, runId: string, signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.forRunInternal(target, runId, active));
  }
  create(target: ChangesTarget, runId: string, signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.createInternal(target, runId, active));
  }
  list(target: ChangesTarget, limit = 20, before?: string, signal = AbortSignal.timeout(30_000)) {
    return this.lifetime.run(signal, (active) => this.listInternal(target, limit, before, active));
  }
  get(target: ChangesTarget, id: string, signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.getInternal(target, id, active));
  }
  restore(input: Parameters<FileCheckpointService["restoreInternal"]>[0], signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.restoreInternal(input, active));
  }
  recover(target: ChangesTarget, id: string, signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.recoverInternal(target, id, active));
  }
  restores(
    target: ChangesTarget,
    id: string,
    limit = 10,
    before?: string,
    signal = AbortSignal.timeout(30_000),
  ) {
    return this.lifetime.run(signal, (active) =>
      this.restoresInternal(target, id, limit, before, active),
    );
  }
  resume(target: ChangesTarget, id: string, signal: AbortSignal) {
    return this.lifetime.run(signal, (active) => this.resumeInternal(target, id, active));
  }
  dispose() {
    return this.lifetime.dispose();
  }
}
