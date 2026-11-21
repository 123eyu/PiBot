import type { ChangesPort, WorkspaceLocal as LocalService } from "@pibot/brain/kit";
import { createGitReader, type GitReader } from "@pibot/execution";
import type { OfficeComparePort } from "@pibot/office-contract";
import type { ChangesTarget, MethodParams } from "@pibot/workspaces-contract/full";
import { GeneratedCommitMessageSchema } from "@pibot/workspaces-contract/full";
import { type ChangesScope, changesError, resolveChangesScope } from "./changes-scope.ts";
import { watchChanges } from "./changes-watch.ts";
import type { LineStats, StatusEntry } from "./git/changes-git.ts";
import { parseStatus } from "./git/changes-git.ts";
import { STATS_WAIT_MS } from "./git/changes-status.ts";
import { turnDiff, turnFiles } from "./review/changes-diff.ts";
import { turnFile } from "./review/changes-file.ts";
import { recordFinding } from "./review/changes-review.ts";
import { assertWorktreeReceipt, verifyWorktreeReceipt } from "./review/changes-worktree-views.ts";
import { RunChanges } from "./write/changes-turn.ts";

const WATCHED_ROOTS = 4;
const CACHED_ROOTS = 16;

function lru<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value as K);
}
/** Owns the Git reader, the per-run recorder, caches and the folder watches for the sidebar. */
export class ChangesService {
  recordFinding(...args: Parameters<ChangesPort["recordFinding"]>) {
    return recordFinding(this, ...args);
  }
  turnDiff(...args: Parameters<ChangesPort["turnDiff"]>) {
    return turnDiff(this, ...args);
  }
  turnFile(...args: Parameters<ChangesPort["turnFile"]>) {
    return turnFile(this, ...args);
  }
  turnFiles(runId: string, signal: AbortSignal) {
    return turnFiles(this, { runId }, signal);
  }
  parseStatus = parseStatus;
  verifyReceipt(
    receipt: Parameters<ChangesPort["verifyReceipt"]>[0],
    signal: AbortSignal,
    pinGit?: boolean,
  ) {
    return verifyWorktreeReceipt(this.local, receipt, signal, pinGit);
  }
  assertReceipt = assertWorktreeReceipt;
  /** User writes share the same root/drain lease as agent writes; managed writes already hold it. */
  userWriteLease?: <T>(
    scope: ChangesScope,
    signal: AbortSignal,
    operation: (signal: AbortSignal, assertAuthorized: () => void) => Promise<T>,
  ) => Promise<T>;
  /** Only the managed registry can attest an explicit binding and issue narrow admin writes. */
  managedLayout?: {
    allows(scope: ChangesScope, signal: AbortSignal): Promise<boolean>;
    write(
      scope: ChangesScope,
      operations: import("@pibot/execution").GitWriteOperation[],
      signal: AbortSignal,
    ): Promise<
      Pick<
        import("@pibot/execution").CommandResult,
        "exitCode" | "durationMs" | "timedOut" | "stopped"
      >
    >;
  };
  readonly reader: GitReader;
  readonly turn: RunChanges;
  readonly platform: "darwin" | "linux" | "win32";
  readonly writing = new Set<string>();
  /** Office document comparison; absent when the office capability is not installed. */
  office?: OfficeComparePort;
  /** Set by brain index (changes-draft.ts) when the agent can draft; absent means draft_unavailable. */
  drafter?: (scope: ChangesScope, paths: string[], signal: AbortSignal) => Promise<string>;
  private readonly lifetime = new AbortController();
  private readonly statuses = new Map<string, Map<string, StatusEntry>>();
  private readonly statsCache = new Map<string, { key: string; stats: Map<string, LineStats> }>();
  private readonly statsJobs = new Map<string, { key: string; job: Promise<unknown> }>();
  private readonly counts = new Map<string, LineStats | undefined>();
  private readonly watches = new Map<
    string,
    { stop(): Promise<void>; targets: Map<string, { conversationKey: string; topicId?: string }> }
  >();
  constructor(readonly local: LocalService) {
    this.platform = local.deps.platform;
    this.reader = createGitReader({
      platform: local.deps.platform,
      env: local.deps.env,
      userHome: local.deps.userHome,
    });
    this.turn = new RunChanges({
      db: local.deps.db,
      dataDir: local.deps.dataDir,
      platform: local.deps.platform,
      logger: local.deps.logger,
      peer: local.deps.peer,
      target: local.target,
      checkpointScopeKey(context) {
        const internal = context.executionTaskId
          ? local.tasks.tasks.internal(context.executionTaskId)
          : undefined;
        if (context.executionTaskId && !internal) throw new Error("office_checkpoint_unavailable");
        const source = internal?.authority.source ?? context;
        return `${source.groupId ? `group:${source.groupId}` : `dm:${source.botId}`}|${source.groupId ? "" : (source.conversationId ?? "")}`;
      },
    });
  }
  /** Every RPC gets the service lifetime plus a bound; nothing waits on a stuck Git forever. */
  signal(timeoutMs = 60_000) {
    return AbortSignal.any([
      this.lifetime.signal,
      this.local.shutdown.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
  }
  scope(target: ChangesTarget, signal: AbortSignal) {
    return resolveChangesScope(
      this.local,
      {
        conversationKey: target.conversationKey,
        ...(target.topicId ? { topicId: target.topicId } : {}),
        ...(target.rootId ? { rootId: target.rootId } : {}),
      },
      signal,
    );
  }
  remember(root: string, entries: StatusEntry[]) {
    lru(this.statuses, root, new Map(entries.map((e) => [e.path, e])), CACHED_ROOTS);
  }
  remembered(root: string) {
    return this.statuses.get(root);
  }
  forget(root: string) {
    this.statuses.delete(root);
  }
  /** Small memo for turn line counts; snapshot refs are content hashes, so entries never go stale. */
  async cached(key: string, compute: () => Promise<LineStats | undefined>) {
    if (this.counts.has(key)) return this.counts.get(key);
    const value = await compute();
    lru(this.counts, key, value, 1000);
    return value;
  }
  /**
   * Line counts for a status snapshot. Answers within STATS_WAIT_MS when possible; otherwise the
   * job keeps running under the service lifetime and a "stats" event tells the UI to re-read.
   */
  async stats(
    scope: ChangesScope,
    key: string,
    compute: (signal: AbortSignal) => Promise<Map<string, LineStats>>,
  ) {
    const root = scope.root.path;
    const hit = this.statsCache.get(root);
    if (hit?.key === key) return hit.stats;
    let running = this.statsJobs.get(root);
    if (running?.key !== key) {
      const job = compute(this.signal(120_000)).then((stats) => {
        lru(this.statsCache, root, { key, stats }, CACHED_ROOTS);
        return stats;
      });
      running = { key, job };
      this.statsJobs.set(root, running);
      void job
        .finally(() => {
          if (this.statsJobs.get(root)?.job === job) this.statsJobs.delete(root);
        })
        .catch(() => this.local.deps.logger.warn("Change line counts failed"));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = Symbol("late");
    const first = await Promise.race([
      running.job.catch(() => undefined),
      new Promise<typeof late>((resolve) => {
        timer = setTimeout(() => resolve(late), STATS_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (first !== late) return (first as Map<string, LineStats> | undefined) ?? null;
    void running.job.then(
      () => this.notify(scope, "stats"),
      () => undefined,
    );
    return null;
  }
  notify(
    scope: Pick<ChangesScope, "conversationKey" | "topicId">,
    reason: "files" | "stats" | "review" = "files",
  ) {
    this.local.deps.peer.emit("changes.changed", {
      conversationKey: scope.conversationKey,
      ...(scope.topicId ? { topicId: scope.topicId } : {}),
      reason,
    });
  }
  async watch(params: MethodParams["changes.watch"], signal: AbortSignal) {
    if (!params.on) {
      // Releasing an owned watcher reads nothing; its topic may already be archived or revoked.
      const target = `${params.conversationKey}|${params.topicId ?? ""}`;
      for (const [root, value] of [...this.watches]) {
        if (!value.targets.delete(target) || value.targets.size) continue;
        this.watches.delete(root);
        await value.stop();
      }
      return { ok: true as const };
    }
    const scope = await this.scope(params, signal);
    const root = scope.root.path;
    const target = `${scope.conversationKey}|${scope.topicId ?? ""}`;
    const current = this.watches.get(root);
    // A conversation is watched in one folder at a time: after its folder changed, watching again
    // (or unwatching) must also drop it from the folder it was watched in before.
    for (const [other, value] of [...this.watches]) {
      if ((other === root && params.on) || !value.targets.delete(target) || value.targets.size)
        continue;
      this.watches.delete(other);
      await value.stop();
    }
    if (!params.on) return { ok: true as const };
    if (current) {
      current.targets.set(target, {
        conversationKey: scope.conversationKey,
        topicId: scope.topicId,
      });
      lru(this.watches, root, current, Number.MAX_SAFE_INTEGER);
      return { ok: true as const };
    }
    const targets = new Map([
      [target, { conversationKey: scope.conversationKey, topicId: scope.topicId }],
    ]);
    const watch = await watchChanges(
      this,
      root,
      () => {
        this.forget(root);
        for (const value of targets.values()) this.notify(value);
      },
      () => {
        this.local.deps.logger.warn("Changes watch stopped");
        const current = this.watches.get(root);
        if (current?.targets === targets) {
          this.watches.delete(root);
          void current.stop();
        }
      },
      signal,
    );
    const raced = this.watches.get(root);
    if (raced) {
      await watch.stop();
      for (const [key, value] of targets) raced.targets.set(key, value);
      return { ok: true as const };
    }
    lru(this.watches, root, { stop: watch.stop, targets }, Number.MAX_SAFE_INTEGER);
    // Bounded so a renderer reload that never unwatches cannot accumulate watchers.
    while (this.watches.size > WATCHED_ROOTS) {
      const [oldest, value] = this.watches.entries().next().value as [
        string,
        { stop(): Promise<void> },
      ];
      this.watches.delete(oldest);
      await value.stop();
    }
    return { ok: true as const };
  }
  async draftMessage(params: MethodParams["changes.draftMessage"], signal: AbortSignal) {
    if (!this.drafter) throw changesError("changes_draft_unavailable");
    const scope = await this.scope(params, signal);
    const result = GeneratedCommitMessageSchema.safeParse(
      await this.drafter(scope, params.paths, signal),
    );
    if (!result.success) throw changesError("changes_draft_invalid");
    return { message: result.data };
  }
  quiesce() {
    this.lifetime.abort();
  }
  async dispose() {
    this.quiesce();
    this.reader.dispose();
    const watches = [...this.watches.values()];
    this.watches.clear();
    const settled = await Promise.allSettled([
      ...watches.map((w) => w.stop()),
      ...[...this.statsJobs.values()].map((value) => value.job),
      this.turn.dispose(),
    ]);
    // Stats cancellation is expected; failed watcher cleanup cannot certify database shutdown.
    if (
      settled.slice(0, watches.length).some((result) => result.status === "rejected") ||
      settled.at(-1)?.status === "rejected"
    )
      throw new Error("changes_cleanup_unconfirmed");
  }
}
