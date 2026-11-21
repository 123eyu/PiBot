import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ToolRunContext } from "@pibot/brain/kit";
import { AGENT_PLACEHOLDER_PATHS, type ExecutionTarget, managedIdentity } from "@pibot/execution";
import type { Logger } from "@pibot/observability";
import { containsPath } from "@pibot/policy";
import { watchTree } from "@pibot/scheduler";
import { ReviewFindingsRepo, RunFileChangesRepo, transaction } from "@pibot/storage";
import type { Events, Methods, Peer } from "@pibot/workspaces-contract/full";
import {
  type FolderPresence,
  type ObservedPath,
  observedPaths,
  scanPresence,
} from "../review/changes-presence.ts";
import { prepareOfficeCheckpoint, pruneOfficeBlobs } from "./office-checkpoint.ts";
import { SnapshotBudget } from "./snapshot-budget.ts";

/** Command-observed paths recorded per run (what the panel lists). */
const COMMAND_PATHS = 500;
/**
 * Paths a folder watch keeps in memory until the run ends. Larger than COMMAND_PATHS because a test
 * run can create and remove thousands of temp files; those are dropped at the end (or when this
 * fills up), so they cannot crowd out the files the turn really changed.
 */
const WATCH_PATHS = 5000;
/**
 * SRT's default write-deny names. On Linux it bind-mounts every one that is missing in the
 * working folder, and the empty bind target stays until the sandbox host exits — so a background
 * command's leftovers looked like files the command had changed (L4-2). Only an empty file of
 * one of these names qualifies; a command that writes one leaves content behind.
 */
const SANDBOX_MOUNT_NAMES = new Set([
  // Kali acceptance 2026-11-11: .gitconfig and .idea placeholders were listed as changes.
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  // Empty placeholder *directories* never reach sandboxNoise (observedPaths drops non-files),
  // so only names that could show up as an empty file need adding here.
  ".vscode",
  ".idea",
]);
const AGENT_PLACEHOLDERS = new Set(AGENT_PLACEHOLDER_PATHS);
const id = /^[0-9a-f-]{36}$/;

/**
 * A watched path that is sandbox noise rather than a change of this turn: an empty bind target
 * (L4-2), or a link leading out of the folder whose target the sandbox rebinds on every command.
 * Both are judged against the turn's "before" listing, so a command that truncates an existing
 * `.bashrc` or repoints a link is still recorded as a change.
 */
async function sandboxNoise(
  root: string,
  path: string,
  platform: RunChangesDeps["platform"],
  presence: FolderPresence | undefined,
) {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return false;
  const rel = relative(root, path).replaceAll("\\", "/");
  const before = presence?.before(rel);
  // Without a "before" answer nothing is noise: a change must never vanish from the panel.
  if (before === undefined) return false;
  const placeholder =
    info.isFile() &&
    info.size === 0 &&
    (SANDBOX_MOUNT_NAMES.has(basename(path).toLowerCase()) ||
      // An external agent's sandbox leaves the same kind of empty bind targets for the hook
      // and plugin names it denies (opencode.json, .opencode/plugins, .cursor/hooks.json, ...).
      AGENT_PLACEHOLDERS.has(rel));
  // A pre-existing file truncated to zero bytes (`: > .bashrc`) is a change the user must see.
  if (placeholder) return before === "absent";
  if (!info.isSymbolicLink()) return false;
  const target = await realpath(path).catch(() => undefined);
  if (target && containsPath(root, target, platform)) return false;
  // Only a link that pointed at the same outside target before the turn was re-created by the
  // sandbox lease; one the turn made or repointed is a change, shown as the link itself.
  const was = presence?.beforeLink(rel);
  const now = await readlink(path).catch(() => undefined);
  return was !== undefined && now !== undefined && was === now;
}

interface Pending {
  existed: boolean;
  beforeRef: string | null;
  beforeMode?: number | null;
}
interface Watch {
  stop(): Promise<void>;
  paths: Set<string>;
  /** Resolves once the folder's "before" listing exists; commands wait for it. */
  ready: Promise<void>;
  presence?: FolderPresence;
  reconcile?: boolean;
  ignore?: (path: string) => boolean;
  compacting?: Promise<void>;
  compactedAt?: number;
}
interface ActiveRun {
  context: ToolRunContext;
  watches: Map<string, Watch>;
}
export interface RunChangesDeps {
  db: DatabaseSync;
  dataDir: string;
  platform: "darwin" | "linux" | "win32";
  logger: Logger;
  peer: Peer<typeof Methods, typeof Events>;
  target: ExecutionTarget;
  checkpointScopeKey?: (context: ToolRunContext) => string;
  /** Follows the screenshot retention setting; 7 days until that setting exists. */
  retentionDays?: () => number;
}

/** Ignored for "this turn": Git internals, Pi Bot's own files and dependency trees. */
export function turnIgnored(path: string) {
  return (
    path === ".git" ||
    path.startsWith(".git/") ||
    // The Bot home's own command logs (when home is the working folder) are not user changes;
    // `.pibot/out` holds the user's deliverables and is shown like any other folder.
    // The folder itself must stay visible too, or a watch never descends into it (Linux
    // acceptance 2026-11-20: twelve files a command wrote into .pibot/out were never seen).
    (path.startsWith(".pibot/") && path !== ".pibot/out" && !path.startsWith(".pibot/out/")) ||
    path.split("/").includes("node_modules") ||
    /(?:^|\/)\.pibot-[0-9a-f-]{36}\.tmp$/.test(path) ||
    // Windows acceptance: every PowerShell run rewrites its own startup cache in the Bot home,
    // which then showed up as "changed 1 file" after each approved command.
    /(?:^|\/)AppData\/Local\/Microsoft\/Windows\/PowerShell\/StartupProfileData-[A-Za-z]+$/.test(
      path,
    )
  );
}

/**
 * Records what a run changed: write/edit tools snapshot content before and after;
 * commands only reveal paths, observed by a folder watch that lives exactly as long as the run.
 */
export class RunChanges {
  readonly repo: RunFileChangesRepo;
  private readonly active = new Map<string, ActiveRun>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly first: ReturnType<typeof setTimeout>;
  private pruning?: Promise<void>;
  readonly snapshotBudget: SnapshotBudget;
  constructor(private readonly deps: RunChangesDeps) {
    this.repo = new RunFileChangesRepo(deps.db);
    this.snapshotBudget = new SnapshotBudget(deps.dataDir);
    const prune = () => {
      if (this.pruning) return;
      this.pruning = this.prune()
        .catch(() => deps.logger.warn("Turn snapshot cleanup failed"))
        .finally(() => {
          this.pruning = undefined;
        });
    };
    // Cleanup is off the startup path; the interval matches the daily retention granularity.
    this.first = setTimeout(prune, 30_000);
    this.timer = setInterval(prune, 6 * 60 * 60 * 1000);
    this.first.unref?.();
    this.timer.unref?.();
  }
  snapshotDir(botId: string, runId: string) {
    if (!id.test(botId) || !id.test(runId)) throw new Error("Invalid snapshot owner");
    return join(this.deps.dataDir, "bots", botId, "changes", runId);
  }
  begin(context: ToolRunContext) {
    if (!this.active.has(context.runId))
      this.active.set(context.runId, { context, watches: new Map() });
  }
  /** Contexts of runs that are executing now; used to refuse discard/commit into their folder. */
  running() {
    return [...this.active.values()].map((run) => run.context);
  }
  private async read(
    path: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; mode: number } | "missing" | "unavailable"> {
    try {
      const value = await this.deps.target.readCheckpoint(
        path,
        signal,
        /\.(docx|xlsx|pptx)$/i.test(path) ? 100 * 1024 * 1024 : undefined,
      );
      return { bytes: value.bytes, mode: value.image.mode };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
    }
  }
  private async storeBytes(context: ToolRunContext, bytes: Buffer, requireVerified = false) {
    const dir = this.snapshotDir(context.botId, context.runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(bytes).digest("hex");
    // Content-addressed: repeated writes of the same version in a run are stored once.
    const handle = await open(join(dir, hash), "wx", 0o600).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return undefined;
        throw error;
      },
    );
    if (handle) {
      let complete = false;
      try {
        await handle.writeFile(bytes, {
          signal: requireVerified
            ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(20_000),
        });
        if (requireVerified) await handle.sync();
        this.snapshotBudget.added(bytes.length);
        complete = true;
      } finally {
        await handle.close();
        if (!complete) await rm(join(dir, hash), { force: true });
      }
    }
    return hash;
  }
  private snapshotQueue: Promise<unknown> = Promise.resolve();
  withSnapshotLease<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let started = false;
    const pending = this.snapshotQueue
      .catch(() => undefined)
      .then(() => {
        signal.throwIfAborted();
        started = true;
        return operation();
      });
    this.snapshotQueue = pending;
    // Cancellation removes this caller's wait immediately; its queued callback can never run.
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (!started) reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  private store(
    context: ToolRunContext,
    bytes: Buffer,
    office: boolean,
    requireVerified = false,
  ): Promise<string> {
    if (!office) return this.storeBytes(context, bytes, requireVerified);
    const signal = requireVerified ? context.signal : AbortSignal.timeout(20_000);
    return this.withSnapshotLease(async () => {
      const saved = join(
        this.snapshotDir(context.botId, context.runId),
        createHash("sha256").update(bytes).digest("hex"),
      );
      const existing = await stat(saved).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      await this.snapshotBudget.admit(existing ? 0 : bytes.length, signal);
      return this.storeBytes(context, bytes, requireVerified);
    }, signal);
  }
  /** Ordinary writes are best effort; an expected revision requests verified before-image evidence. */
  async beforeWrite(
    context: ToolRunContext,
    path: string,
    expectedRevision?: string,
  ): Promise<Pending> {
    try {
      const bytes = await this.read(path, context.signal);
      if (bytes === "missing") return { existed: false, beforeRef: null };
      if (bytes === "unavailable") return { existed: true, beforeRef: null };
      const missing = { existed: true, beforeRef: null };
      if (
        expectedRevision &&
        createHash("sha256").update(bytes.bytes).digest("hex") !== expectedRevision
      )
        return missing;
      const beforeRef = await this.store(
        context,
        bytes.bytes,
        /\.(docx|xlsx|pptx)$/i.test(path),
        !!expectedRevision,
      );
      if (expectedRevision) {
        const saved = await this.deps.target.readCheckpoint(
          join(this.snapshotDir(context.botId, context.runId), beforeRef),
          context.signal,
          /\.(docx|xlsx|pptx)$/i.test(path) ? 100 * 1024 * 1024 : undefined,
        );
        if (saved.image.hash !== expectedRevision) return missing;
      }
      return { existed: true, beforeRef, beforeMode: bytes.mode };
    } catch {
      this.deps.logger.warn(`Turn snapshot failed bot=${context.botId} run=${context.runId}`);
      return { existed: true, beforeRef: null };
    }
  }
  prepareOfficeWrite(
    context: ToolRunContext,
    before: Pending,
    path: string,
    root: string,
    candidate: Uint8Array,
    assertCurrent: () => void,
  ) {
    return this.withSnapshotLease(
      () =>
        prepareOfficeCheckpoint({
          ...this.deps,
          context,
          before,
          path,
          root,
          candidate,
          scopeKey: this.deps.checkpointScopeKey?.(context),
          assertCurrent,
          budget: this.snapshotBudget,
        }),
      context.signal,
    );
  }
  async afterWrite(
    context: ToolRunContext,
    pending: Pending,
    path: string,
    root: string,
    expectedAfterRevision?: string,
  ) {
    try {
      const identity = context.runWorkplace?.boundary.roots.find(
        (value) => value.canonicalPath === root,
      );
      // A completed write still needs its after-image when Stop arrived just after publication.
      // This bounded bookkeeping does not execute another tool or reuse the cancelled run signal.
      const captureSignal = AbortSignal.timeout(20_000);
      const checkRoot = async () => {
        if (!identity?.device || !identity.inode) throw new Error("Snapshot root unavailable");
        const current = await managedIdentity(root);
        if (current.device !== identity.device || current.inode !== identity.inode)
          throw new Error("Snapshot root changed");
      };
      await checkRoot();
      let bytes = await this.read(path, captureSignal);
      if (
        expectedAfterRevision &&
        (typeof bytes === "string" ||
          createHash("sha256").update(bytes.bytes).digest("hex") !== expectedAfterRevision)
      )
        bytes = "unavailable";
      await checkRoot();
      if (!pending.existed && bytes === "missing") return;
      const afterRef =
        typeof bytes !== "string"
          ? await this.store(context, bytes.bytes, /\.(docx|xlsx|pptx)$/i.test(path))
          : null;
      if (
        pending.existed &&
        afterRef &&
        afterRef === pending.beforeRef &&
        typeof bytes !== "string" &&
        bytes.mode === pending.beforeMode
      )
        return;
      transaction(this.deps.db, () =>
        this.repo.record({
          runId: context.runId,
          botId: context.botId,
          root,
          path,
          kind: pending.existed ? (bytes === "missing" ? "delete" : "modify") : "add",
          beforeRef: pending.beforeRef,
          afterRef,
          beforeMode: pending.beforeMode ?? null,
          afterMode: typeof bytes !== "string" ? bytes.mode : null,
          rootDevice: identity?.device ?? null,
          rootInode: identity?.inode ?? null,
        }),
      );
    } catch {
      this.deps.logger.warn(`Turn record failed bot=${context.botId} run=${context.runId}`);
    }
  }
  /**
   * Started lazily before the first command in a folder; stopped by finish(). Resolves when the
   * command may start: the watch runs and the folder's "before" listing is taken.
   */
  watchCommand(context: ToolRunContext, root: string, reconcile = false): Promise<void> {
    const run = this.active.get(context.runId);
    if (!run) return Promise.resolve();
    const existing = run.watches.get(root);
    if (existing) return existing.ready;
    const data = containsPath(root, this.deps.dataDir, this.deps.platform)
      ? relative(root, this.deps.dataDir).split(/[\\/]/).join("/")
      : undefined;
    const ignore = (path: string) =>
      turnIgnored(path) || (!!data && (path === data || path.startsWith(`${data}/`)));
    const paths = new Set<string>();
    let entry: Watch | undefined;
    try {
      const watch = watchTree({
        root,
        platform: this.deps.platform,
        ignore,
        maxPaths: WATCH_PATHS,
        onChange: (changed) => {
          for (const path of changed) {
            if (paths.size < WATCH_PATHS) paths.add(path);
            else if (entry) this.compact(root, entry);
          }
        },
        onError: () =>
          this.deps.logger.warn(`Turn watch stopped bot=${context.botId} run=${context.runId}`),
      });
      // The watch starts first, so nothing a command does can fall between listing and watch.
      const ready = scanPresence(root, ignore, context.signal, undefined, reconcile).then(
        (presence) => {
          if (entry) entry.presence = presence;
        },
        () =>
          // Without a listing every vanished path is "unknown" and still recorded, as before.
          this.deps.logger.warn(`Turn listing failed bot=${context.botId} run=${context.runId}`),
      );
      entry = { stop: watch.stop, paths, ready, reconcile, ignore };
      run.watches.set(root, entry);
      return ready;
    } catch {
      this.deps.logger.warn(`Turn watch unavailable bot=${context.botId} run=${context.runId}`);
      return Promise.resolve();
    }
  }
  /** Frees room in a full watch by dropping folders and temp paths that already came and went. */
  private compact(root: string, watch: Watch) {
    // At most every few seconds: a full watch of unscanned paths may free nothing.
    if (watch.compacting || Date.now() - (watch.compactedAt ?? 0) < 3000) return;
    watch.compactedAt = Date.now();
    const rels = [...watch.paths];
    watch.compacting = observedPaths(root, rels, watch.presence)
      .then((kept) => {
        const keep = new Set(kept.map(({ path }) => path));
        // Only the snapshot: paths that arrived during compaction were not looked at.
        for (const rel of rels)
          if (!keep.has(join(root, ...rel.split("/")))) watch.paths.delete(rel);
      })
      .catch(() => this.deps.logger.warn("Turn watch compaction failed"))
      .finally(() => {
        watch.compacting = undefined;
      });
  }
  /** Whether a command of this run is being watched (its paths arrive up to ~1 s late). */
  watching(runId: string) {
    return !!this.active.get(runId)?.watches.size;
  }
  /**
   * Absolute paths this still-running run changed so far: write / edit tool records plus
   * the files its commands changed or removed (temp files they created and removed are left out).
   */
  async touched(runId: string): Promise<string[]> {
    // A finish already running records the command paths; read after it.
    // Its own caller reports a failed finish; here only the ordering matters.
    await this.finishing.get(runId)?.catch(() => undefined);
    const paths = new Set(this.repo.paths(runId));
    for (const [root, watch] of this.active.get(runId)?.watches ?? []) {
      await addUnseenNewFiles(root, watch);
      for (const { path } of await observedPaths(root, [...watch.paths], watch.presence))
        if (!(await sandboxNoise(root, path, this.deps.platform, watch.presence))) paths.add(path);
    }
    return [...paths];
  }
  /**
   * Linux acceptance 2026-11-20: a stopped run's delivery asked touched() while finish() had
   * already dropped the run from `active` but not yet recorded what its commands wrote, so it
   * saw nothing. touched() waits for a finish in progress.
   */
  private readonly finishing = new Map<string, Promise<void>>();
  finish(context: ToolRunContext): Promise<void> {
    const run = this.active.get(context.runId);
    if (!run || run.context !== context) return Promise.resolve();
    const work = this.finishRun(context, run).finally(() => {
      if (this.finishing.get(context.runId) === work) this.finishing.delete(context.runId);
    });
    this.finishing.set(context.runId, work);
    return work;
  }
  private async finishRun(context: ToolRunContext, run: ActiveRun) {
    this.active.delete(context.runId);
    await Promise.allSettled([...run.watches.values()].map((watch) => watch.stop()));
    const recorded = this.repo.paths(context.runId);
    const commands: (ObservedPath & { root: string })[] = [];
    for (const [root, watch] of run.watches) {
      // A run cancelled while its first command waited for the listing still has it pending.
      await watch.ready;
      await watch.compacting;
      // ACP agents write themselves: a final bounded comparison covers missing OS events too.
      if (watch.reconcile && watch.presence && watch.ignore) {
        const after = await scanPresence(
          root,
          watch.ignore,
          AbortSignal.timeout(2_000),
          undefined,
          true,
        );
        for (const [rel, signature] of after.files)
          if (
            watch.presence.before(rel) === "absent" ||
            (watch.presence.files.has(rel) && watch.presence.files.get(rel) !== signature)
          )
            watch.paths.add(rel);
        for (const rel of watch.presence.files.keys())
          if (after.before(rel) === "absent") watch.paths.add(rel);
      } else await addUnseenNewFiles(root, watch);
      for (const item of (await observedPaths(root, [...watch.paths], watch.presence)).slice(
        0,
        COMMAND_PATHS,
      ))
        if (
          !recorded.has(item.path) &&
          !(await sandboxNoise(root, item.path, this.deps.platform, watch.presence))
        ) {
          recorded.add(item.path);
          if (watch.reconcile)
            await this.afterWrite(
              context,
              {
                existed:
                  watch.presence?.before(relative(root, item.path).split(/[\\/]/).join("/")) !==
                  "absent",
                beforeRef: null,
              },
              item.path,
              root,
            );
          else commands.push({ root, ...item });
        }
    }
    // Confirmed paths first, so unconfirmed ones never push them over the cap (stable sort).
    commands.sort((a, b) => Number(b.known) - Number(a.known));
    if (commands.length)
      transaction(this.deps.db, () => {
        for (const { root, path } of commands.slice(0, COMMAND_PATHS))
          if (
            !this.repo.record({
              runId: context.runId,
              botId: context.botId,
              root,
              path,
              kind: "command",
              beforeRef: null,
              afterRef: null,
            })
          )
            break;
      });
    if (recorded.size)
      this.deps.peer.emit("changes.changed", { runId: context.runId, reason: "turn" });
  }
  async prune() {
    const days = Math.min(Math.max(this.deps.retentionDays?.() ?? 7, 1), 365);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const expired = transaction(this.deps.db, () =>
      this.repo.expire(new Date(cutoff).toISOString()),
    );
    await this.withSnapshotLease(
      () =>
        pruneOfficeBlobs(
          this.deps.dataDir,
          this.deps.db,
          new Set(this.active.keys()),
          new Date(cutoff).toISOString(),
        ),
      AbortSignal.timeout(30_000),
    );
    // Review findings follow the same retention as the turn they reviewed.
    new ReviewFindingsRepo(this.deps.db).expire(new Date(cutoff).toISOString());
    for (const { botId, runId } of expired)
      if (!this.active.has(runId))
        await rm(this.snapshotDir(botId, runId), { recursive: true, force: true });
    // Snapshots whose rows never got written (crash between write and record) age out by mtime.
    const bots = join(this.deps.dataDir, "bots");
    for (const botId of await readdir(bots).catch(() => [] as string[])) {
      if (!id.test(botId)) continue;
      const base = join(bots, botId, "changes");
      for (const runId of (await readdir(base).catch(() => [] as string[])).slice(0, 2000)) {
        if (!id.test(runId) || this.active.has(runId)) continue;
        const info = await stat(join(base, runId)).catch(() => undefined);
        if (info && info.mtimeMs < cutoff && !this.repo.botOf(runId))
          await rm(join(base, runId), { recursive: true, force: true });
      }
    }
    this.snapshotBudget.invalidate();
  }
  async dispose() {
    clearTimeout(this.first);
    clearInterval(this.timer);
    await this.pruning;
    await this.snapshotQueue.catch(() => undefined);
    const runs = [...this.active.values()];
    this.active.clear();
    const settled = await Promise.allSettled(
      runs.flatMap((run) => [...run.watches.values()].map((watch) => watch.stop())),
    );
    if (settled.some((result) => result.status === "rejected"))
      throw new Error("changes_cleanup_unconfirmed");
  }
}

/**
 * Mac acceptance 2026-11-20: a script that wrote twelve files into `.pibot/out` was recorded with
 * none of them while the system's file-event service was overloaded, so nothing reached the chat.
 * Events can arrive late or be dropped; a bounded listing against the "before" one adds every file
 * that did not exist before the run's first command. Edits to existing files still rely on events.
 */
async function addUnseenNewFiles(root: string, watch: Watch) {
  if (!watch.presence || !watch.ignore || watch.reconcile) return;
  const before = watch.presence;
  const after = await scanPresence(
    root,
    watch.ignore,
    AbortSignal.timeout(2_000),
    undefined,
    true,
  ).catch(() => undefined);
  if (!after) return;
  for (const rel of after.files.keys())
    if (before.before(rel) === "absent" && watch.paths.size < WATCH_PATHS) watch.paths.add(rel);
}
