import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type {
  WorkspaceChat as ChatService,
  WorkspaceGroups as GroupService,
  WorkspaceLocal as LocalService,
  ManagedConfigOwnerProof,
} from "@pibot/brain/kit";
import { abortable } from "@pibot/brain/kit";
import { matchesFileIdentity } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { actualRootReferences, ManagedWorktreesRepo, RunsRepo } from "@pibot/storage";
import type { ChangesScope } from "../changes/changes-scope.ts";
import { resolveRunWorkplace } from "../runtime.ts";
import {
  configurationActivityPaths,
  configurationPublicationLease,
} from "./managed-config-lease.ts";
import { managedError } from "./managed-resource-ports.ts";

const cleanupFailed = (error: unknown) =>
  !!error && typeof error === "object" && "reason" in error && error.reason === "cleanup_failed";
/** Actual queue/process ownership outlives database terminal statuses and cancelled RPC callers. */
export class ManagedResourceLifecycle {
  private readonly activities = new Map<string, number>();
  private readonly browserTakeovers = new Map<string, number>();
  private readonly current = new AsyncLocalStorage<string>();
  private readonly held = new Map<string, { botId: string; paths: string[]; failed: boolean }>();
  constructor(
    private readonly local: LocalService,
    private readonly chat: ChatService,
    private readonly groups: GroupService,
  ) {}
  reserve(botId: string) {
    if (this.browserTakeovers.has(botId)) managedError("managed_browser_busy", "busy");
    this.activities.set(botId, (this.activities.get(botId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.activities.get(botId) ?? 1) - 1;
      if (count) this.activities.set(botId, count);
      else this.activities.delete(botId);
    };
  }
  assertBrowserAvailable(botId: string) {
    if (
      this.activities.has(botId) ||
      [...this.held.values()].some((entry) => entry.botId === botId && entry.failed)
    )
      managedError("managed_resource_busy", "busy");
  }
  beginBrowserTakeover(botId: string) {
    this.assertBrowserAvailable(botId);
    this.browserTakeovers.set(botId, (this.browserTakeovers.get(botId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.browserTakeovers.get(botId) ?? 1) - 1;
      if (count) this.browserTakeovers.set(botId, count);
      else this.browserTakeovers.delete(botId);
    };
  }
  revision = () =>
    JSON.stringify([
      this.chat.queue.resources().healthy,
      this.chat.queue
        .resources()
        .contexts.map((entry) => [
          entry.runId,
          entry.botId,
          entry.conversationId,
          entry.executionTaskId,
          entry.routineRunId,
          entry.routineWorkplace,
        ])
        .sort(),
      this.local.background.resources(),
    ]);
  private paths(scope: ChangesScope, paths: string[]) {
    const expanded = new Set(paths),
      registry = new ManagedWorktreesRepo(this.local.deps.db);
    for (const path of paths) {
      const tree = registry.byPath(path);
      if (!tree || tree.botId !== scope.botId) continue;
      const expected = tree.identity?.common;
      if (!expected || expected.path !== tree.commonDir) managedError("managed_root_changed");
      const info = lstatSync(expected.path, { bigint: true });
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        realpathSync(expected.path) !== expected.path ||
        !matchesFileIdentity(info, expected)
      )
        managedError("managed_root_changed");
      // Git linked trees share metadata with their source repository. Lock it too, but grant no new writes.
      expanded.add(expected.path);
    }
    return [...expanded];
  }
  private overlaps(a: string, b: string) {
    return (
      containsPath(a, b, this.local.deps.platform) || containsPath(b, a, this.local.deps.platform)
    );
  }
  async assertIdle(
    scope: ChangesScope,
    paths: string[],
    signal: AbortSignal,
    owner?: ManagedConfigOwnerProof,
  ) {
    signal.throwIfAborted();
    owner?.assertCurrentOwner();
    const requested = this.paths(scope, [...new Set([scope.primary.path, ...paths])]);
    const queue = this.chat.queue.resources();
    if (
      [...this.held.entries()].some(
        ([id, entry]) =>
          id !== this.current.getStore() &&
          entry.paths.some((root) => requested.some((path) => this.overlaps(root, path))),
      )
    )
      managedError("managed_resource_busy", "busy");
    if (!queue.healthy || (scope.groupId && this.groups.changing(scope.groupId)))
      managedError("managed_resource_busy", "busy");
    const background = this.local.background.resources();
    if (
      background.starting ||
      background.roots.some((root) =>
        configurationActivityPaths(this.local, root, owner).some((active) =>
          requested.some((path) => this.overlaps(active, path)),
        ),
      )
    )
      // Its own code: "in use, retry later" never named the cause, and retrying cannot help
      // while a preview server keeps running (docs guide 2026-11-14, commit in the changes pane).
      managedError("managed_background_running", "busy");
    for (const context of queue.contexts) {
      if (owner && context.runId === owner.call.runId && context.botId === owner.call.botId) {
        owner.assertCurrentOwner();
        if (!owner.ownsQueueEntry(context)) managedError("managed_resource_busy", "busy");
        continue;
      }
      const run = this.chat.queue.repo.get(context.runId);
      // Queued routines have not necessarily captured their configured folders yet.
      if (run?.kind === "routine" && context.routineWorkplace === undefined)
        managedError("managed_resource_busy", "busy");
      let source: { conversationId?: string; groupId?: string } = context;
      try {
        if (context.executionTaskId)
          source = this.local.tasks.source({ ...context, signal, language: "en" });
        if (
          (scope.groupId && source.groupId === scope.groupId) ||
          (scope.conversationId && source.conversationId === scope.conversationId)
        )
          managedError("managed_resource_busy", "busy");
        const place = await resolveRunWorkplace(
          this.local,
          { ...context, signal, language: "en" },
          signal,
        );
        if (
          place.boundary.roots.some((root) =>
            configurationActivityPaths(this.local, root.canonicalPath, owner).some((active) =>
              requested.some((path) => this.overlaps(active, path)),
            ),
          )
        )
          managedError("managed_resource_busy", "busy");
      } catch {
        signal.throwIfAborted();
        // Unknown/invalidated roots can still have open file descriptors; fail closed until drain.
        managedError("managed_resource_busy", "busy");
      }
    }
    const host = this.local.deps.host;
    try {
      if (host.browserView) {
        const view = await abortable(host.browserView.state(scope.botId), signal);
        if (view.takeover || view.recording) managedError("managed_browser_busy", "busy");
      } else if (host.browser) {
        const status = await host.browser.call("host.browser.status", {}, signal);
        if (status.bots.some((entry) => entry.botId === scope.botId && entry.busy))
          managedError("managed_browser_busy", "busy");
      }
    } catch {
      signal.throwIfAborted();
      managedError("managed_browser_busy", "busy");
    }
    signal.throwIfAborted();
    owner?.assertCurrentOwner();
    if (queue.healthy !== this.chat.queue.resources().healthy)
      managedError("managed_resource_busy", "busy");
  }
  configurationExclusive<T>(
    scope: ChangesScope,
    paths: string[],
    owner: ManagedConfigOwnerProof,
    signal: AbortSignal,
    operation: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    return configurationPublicationLease(
      {
        current: this.current,
        held: this.held,
        reserve: (botId) => this.reserve(botId),
        revision: this.revision,
        captureQueue: () => {
          const entries = this.chat.queue.resources().contexts;
          if (entries.filter((entry) => owner.ownsQueueEntry(entry)).length !== 1)
            managedError("managed_resource_busy", "busy");
          return () => {
            const current = this.chat.queue.resources().contexts;
            if (
              current.length !== entries.length ||
              current.some(
                (entry, index) =>
                  entry.runId !== entries[index]?.runId || entry.signal !== entries[index]?.signal,
              ) ||
              current.filter((entry) => owner.ownsQueueEntry(entry)).length !== 1
            )
              managedError("managed_resource_busy", "busy");
          };
        },
        assertIdle: (scope, paths, signal, owner) => this.assertIdle(scope, paths, signal, owner),
      },
      scope,
      paths,
      owner,
      signal,
      operation,
    );
  }
  async exclusive<T>(
    scope: ChangesScope,
    paths: string[],
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    paths = this.paths(scope, paths);
    await this.assertIdle(scope, paths, signal);
    const existing = this.current.getStore();
    const held = existing ? this.held.get(existing) : undefined;
    if (existing && held) {
      await this.local.writeLocks.acquire({ botId: held.botId, runId: existing }, paths, signal);
      held.paths = [...new Set([...held.paths, ...paths])];
      await this.assertIdle(scope, paths, signal);
      return operation();
    }
    const id = randomUUID();
    await this.local.writeLocks.acquire({ botId: scope.botId, runId: id }, paths, signal);
    this.held.set(id, { botId: scope.botId, paths, failed: false });
    try {
      const result = await this.current.run(id, async () => {
        await this.assertIdle(scope, paths, signal);
        return operation();
      });
      this.local.writeLocks.release(id);
      this.held.delete(id);
      return result;
    } catch (error) {
      if (cleanupFailed(error)) {
        const entry = this.held.get(id);
        if (entry) entry.failed = true;
        // Keep the actual shared lock: no later write may mistake failed cleanup for completion.
      } else {
        this.local.writeLocks.release(id);
        this.held.delete(id);
      }
      throw error;
    }
  }
  async referenced(path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      actualRootReferences(
        this.local.deps.db,
        path,
        this.local.deps.platform,
        this.local.deps.dataDir,
        new ManagedWorktreesRepo(this.local.deps.db).byPath(path)?.sourcePath,
      )
    )
      return true;
    if (
      this.held.size &&
      [...this.held.entries()].some(
        ([id, entry]) =>
          id !== this.current.getStore() && entry.paths.some((root) => this.overlaps(root, path)),
      )
    )
      return true;
    const background = this.local.background.resources();
    if (background.starting || background.roots.some((root) => this.overlaps(root, path)))
      return true;
    const queue = this.chat.queue.resources();
    if (!queue.healthy) return true;
    for (const context of queue.contexts) {
      if (
        new RunsRepo(this.local.deps.db).get(context.runId)?.kind === "routine" &&
        context.routineWorkplace === undefined
      )
        return true;
      try {
        const place = await resolveRunWorkplace(
          this.local,
          { ...context, signal, language: "en" },
          signal,
        );
        if (place.boundary.roots.some((root) => this.overlaps(root.canonicalPath, path)))
          return true;
      } catch {
        signal.throwIfAborted();
        return true;
      }
    }
    return false;
  }
  dispose() {
    // Failed isolation cleanup has no recovery certificate. Leave its lease until LocalService exits.
    if ([...this.held.values()].some((entry) => entry.failed))
      throw new Error("managed_cleanup_unconfirmed");
    if (this.held.size) throw new Error("managed_operations_not_drained");
  }
}
