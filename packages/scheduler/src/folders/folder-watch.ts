import { join, relative } from "node:path";
import { watch } from "chokidar";
import {
  type FolderTriggerConfig,
  type FolderTriggerState,
  inside,
  scanFolder,
  snapshotChanges,
} from "./snapshot.ts";

interface FolderTrigger {
  config: FolderTriggerConfig;
  state: FolderTriggerState;
}

export async function watchFolder(opts: {
  trigger: FolderTrigger;
  dataDir: string;
  signal: AbortSignal;
  now(): number;
  checkpoint(
    expected: FolderTriggerState,
    next: FolderTriggerState,
    paths: string[],
    total: number,
  ): Promise<void> | Promise<boolean>;
  error(reason: string): Promise<void>;
}) {
  const config = opts.trigger.config;
  if (config.kind !== "folder") throw new Error("invalid_watch_trigger");
  const lifetime = new AbortController(),
    signal = AbortSignal.any([opts.signal, lifetime.signal]);
  // Preflight before chokidar recursively allocates native watchers.
  const initial = await scanFolder(config, opts.dataDir, signal, opts.now());
  let state = opts.trigger.state;
  if (!state.snapshot?.complete) {
    const baseline = { ...state, snapshot: initial };
    // Persist before returning the monitor to its creator; the first later scan must not swallow new files.
    if ((await opts.checkpoint(state, baseline, [], 0)) === false)
      throw new Error("watch_checkpoint_deferred");
    state = baseline;
  }
  let ready = false,
    closed = false,
    generation = 1,
    scanned = 0;
  let lastChange = 0,
    nextScan = 0,
    fault: string | undefined,
    running = false;
  let pending: Promise<void> = Promise.resolve(),
    failure: unknown;
  const seen = new Set<string>(),
    started = opts.now();
  const watcher = watch(config.path, {
    followSymlinks: false,
    ignoreInitial: true,
    alwaysStat: true,
    ignorePermissionErrors: false,
    depth: config.recursive ? 32 : 0,
    atomic: 100,
    awaitWriteFinish: false,
    usePolling: false,
    ignored: (file, stat) => {
      const rel = relative(config.path, file);
      if (
        rel &&
        (inside(opts.dataDir, file) ||
          rel
            .split(/[\\/]/)
            .some(
              (p) =>
                p.startsWith(".") ||
                p.startsWith("~$") ||
                /(?:\.tmp|\.crdownload|\.part|~)$/i.test(p),
            ))
      )
        return true;
      if (stat?.isSymbolicLink()) return true;
      if (!seen.has(file)) {
        if (seen.size >= 10000) {
          fault = "watch_capacity";
          return true;
        }
        seen.add(file);
      }
      return false;
    },
  });
  watcher.on("all", (event, path) => {
    // The capacity bound is for paths that exist now, not every name seen over the watcher's life.
    if (event === "unlink" || event === "unlinkDir") seen.delete(path);
    generation++;
    lastChange = opts.now();
  });
  watcher.on("ready", () => {
    ready = true;
  });
  watcher.on("error", (error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    fault = ["ENOENT", "ENOSPC", "EMFILE", "EACCES", "EPERM", "EIO"].includes(code)
      ? `watch_${code}`
      : "watch_io_error";
  });
  if (watcher.options.usePolling) {
    await watcher.close();
    throw new Error("watch_env_override");
  }
  const tick = async () => {
    if (closed || signal.aborted) return;
    const now = opts.now();
    if (fault) throw new Error(fault);
    if (!ready && now - started > 30000) throw new Error("watch_start_timeout");
    if (
      !ready ||
      (generation === scanned && now < nextScan) ||
      (lastChange && now - lastChange < 10000)
    )
      return;
    const scanGeneration = generation;
    const snapshot = await scanFolder(config, opts.dataDir, signal, now);
    const changes = snapshotChanges(state.snapshot, snapshot, config.events === "new_and_changed");
    if (changes.length && !lastChange) {
      // ignoreInitial can suppress events during startup; metadata differences still need a quiet period.
      lastChange = now;
      return;
    }
    const pendingPaths = new Set([
      ...(state.pendingPaths ?? []),
      ...changes.slice(0, 50).map((p) => join(config.path, p)),
    ]);
    const total = Math.max(state.pendingCount ?? 0, changes.length);
    const cooling =
      !!state.lastTriggeredAt &&
      now - Date.parse(state.lastTriggeredAt) < config.cooldownMin * 60000;
    const fire = total > 0 && !cooling;
    const next: FolderTriggerState = {
      ...state,
      // Retain the comparison baseline during cooldown: repeated edits do not inflate total.
      snapshot: cooling && state.snapshot ? state.snapshot : snapshot,
      pendingPaths: fire ? [] : [...pendingPaths].slice(0, 50),
      pendingCount: fire ? 0 : total,
      ...(fire ? { lastTriggeredAt: new Date(now).toISOString() } : {}),
    };
    signal.throwIfAborted();
    const accepted = await opts.checkpoint(
      state,
      next,
      fire ? [...pendingPaths].slice(0, 50) : [],
      fire ? total : 0,
    );
    // A mutation fence can defer a commit; retaining the baseline preserves all unconsumed facts.
    if (accepted === false) return;
    state = next;
    scanned = scanGeneration;
    nextScan = cooling
      ? Math.min(
          now + 60000,
          Date.parse(state.lastTriggeredAt as string) + config.cooldownMin * 60000,
        )
      : now + 60000;
  };
  const timer = setInterval(() => {
    if (closed || running) return;
    running = true;
    pending = tick()
      .catch(async (error: unknown) => {
        if (!signal.aborted) {
          closed = true;
          clearInterval(timer);
          await watcher.close();
          const code = error instanceof Error ? error.message : "";
          await opts.error(
            [
              "watch_capacity",
              "watch_start_timeout",
              "watch_ENOENT",
              "watch_ENOSPC",
              "watch_EMFILE",
              "watch_EACCES",
              "watch_EPERM",
              "watch_EIO",
              "watch_scan_budget",
              "watch_match_budget",
              "watch_root_changed",
              "invalid_watch_root",
              "watch_unavailable",
            ].includes(code)
              ? code
              : "watch_io_error",
          );
        }
      })
      .catch((e: unknown) => {
        failure = e;
      })
      .finally(() => {
        running = false;
      });
  }, 1000);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      closed = true;
      signal.removeEventListener("abort", aborted);
      lifetime.abort();
      clearInterval(timer);
      await watcher.close();
      await pending;
      seen.clear();
      if (failure) throw failure;
    })());
  const aborted = () => {
    void stop().catch((e: unknown) => {
      failure = e;
    });
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) await stop();
  return { stop };
}
