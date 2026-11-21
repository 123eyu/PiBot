import { type FSWatcher, watch as watchNative } from "node:fs";
import { relative, sep } from "node:path";
import { watch as watchChokidar } from "chokidar";

export interface TreeWatchOptions {
  root: string;
  platform: NodeJS.Platform;
  /** Relative paths ("/"-separated) to drop, e.g. ".git/objects/…" or snapshot temp files. */
  ignore(path: string): boolean;
  /** Coalesced change paths, at most once per interval; overflow means more paths were dropped. */
  onChange(paths: string[], overflow: boolean): void;
  onError(reason: string): void;
  intervalMs?: number;
  maxPaths?: number;
}

/**
 * Event-driven, never polling. macOS and Windows use one recursive native watch (FSEvents /
 * ReadDirectoryChangesW). Linux has no recursive inotify, so it reuses the existing chokidar setup
 * with a directory budget instead of an unbounded number of inotify watches.
 */
export function watchTree(options: TreeWatchOptions) {
  const interval = options.intervalMs ?? 1000;
  const maxPaths = options.maxPaths ?? 500;
  const pending = new Set<string>();
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFlush = 0;
  let stopped = false;
  const flush = () => {
    timer = undefined;
    if (stopped || (!pending.size && !overflow)) return;
    lastFlush = Date.now();
    const paths = [...pending];
    const dropped = overflow;
    pending.clear();
    overflow = false;
    options.onChange(paths, dropped);
  };
  const seen = (name: string) => {
    if (stopped) return;
    const path = name.split(sep).join("/");
    if (!path || options.ignore(path)) return;
    if (pending.size >= maxPaths) overflow = true;
    else pending.add(path);
    timer ??= setTimeout(flush, Math.max(0, lastFlush + interval - Date.now()));
  };
  const fail = (reason: string) => {
    if (stopped) return;
    void stop();
    options.onError(reason);
  };
  let native: FSWatcher | undefined;
  let chokidar: ReturnType<typeof watchChokidar> | undefined;
  if (options.platform === "darwin" || options.platform === "win32") {
    native = watchNative(options.root, { recursive: true, persistent: false }, (_event, name) => {
      // A null name means the OS could not say what changed; report the folder itself.
      seen(name ? String(name) : ".");
    });
    native.on("error", () => fail("watch_failed"));
  } else {
    const directories = new Set<string>();
    chokidar = watchChokidar(options.root, {
      followSymlinks: false,
      ignoreInitial: true,
      ignorePermissionErrors: true,
      depth: 32,
      usePolling: false,
      ignored: (file, stat) => {
        const rel = relative(options.root, file).split(sep).join("/");
        if (rel && options.ignore(rel)) return true;
        if (stat?.isDirectory() && directories.add(file).size > 4000) {
          fail("watch_capacity");
          return true;
        }
        return false;
      },
    });
    chokidar.on("all", (_event, file) => seen(relative(options.root, file)));
    chokidar.on("error", () => fail("watch_failed"));
  }
  let stopping: Promise<void> | undefined;
  function stop() {
    stopping ??= (async () => {
      if (timer) clearTimeout(timer);
      // Drain coalesced events before closing; short turns otherwise lose their final writes.
      flush();
      stopped = true;
      native?.close();
      await chokidar?.close();
    })();
    return stopping;
  }
  return { stop };
}
