import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import { compileFilenamePattern } from "./filename-pattern.ts";

export interface FolderTriggerConfig {
  kind: "folder";
  path: string;
  events: "new" | "new_and_changed";
  pattern: string;
  recursive: boolean;
  cooldownMin: number;
}
export interface FolderSnapshot {
  entries: Array<{ relativePath: string; size: number; mtimeMs: number }>;
  at: string;
  complete: boolean;
}
export interface FolderTriggerState {
  snapshot?: FolderSnapshot;
  lastTriggeredAt?: string | null;
  pendingPaths?: string[];
  pendingCount?: number;
  [key: string]: unknown;
}

export function inside(root: string, value: string) {
  const rel = relative(root, value);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function ignored(name: string) {
  return (
    name.startsWith(".") || name.startsWith("~$") || /(?:\.tmp|\.crdownload|\.part|~)$/i.test(name)
  );
}
export async function scanFolder(
  config: FolderTriggerConfig,
  dataDir: string,
  signal: AbortSignal,
  now = Date.now(),
  paused?: { after: number; previous: FolderTriggerState["snapshot"] },
) {
  const matches = compileFilenamePattern(config.pattern);
  signal.throwIfAborted();
  const root = await realpath(config.path),
    excluded = await realpath(dataDir);
  if (root !== resolve(config.path) || inside(excluded, root))
    throw new Error("invalid_watch_root");
  const entries: { relativePath: string; size: number; mtimeMs: number }[] = [];
  const previous = new Map(
    (paused?.previous?.complete ? paused.previous.entries : []).map((entry) => [
      entry.relativePath,
      entry,
    ]),
  );
  let visited = 0;
  const deadline = performance.now() + 15000;
  async function visit(directory: string, depth: number) {
    signal.throwIfAborted();
    // Root identity uses bigint stats: number inodes lose precision on NTFS (see execution
    // core/file-identity.ts), so a swapped neighbouring folder could otherwise pass.
    const info = await lstat(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new Error("watch_root_changed");
    const dir = await opendir(directory);
    for await (const item of dir) {
      signal.throwIfAborted();
      if (++visited > 10000 || depth > 32 || performance.now() > deadline)
        throw new Error("watch_scan_budget");
      if (visited % 32 === 0) await setImmediate(undefined, { signal });
      if (ignored(item.name)) continue;
      const full = join(directory, item.name);
      if (inside(excluded, full)) continue;
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (config.recursive) await visit(full, depth + 1);
      } else if (stat.isFile() && matches(item.name, signal, deadline)) {
        const entry = {
          relativePath: relative(root, full),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        const before = previous.get(entry.relativePath);
        const observedAt = Date.now();
        // A consumed baseline, not a reconstructed historical directory: retain only evidenced later changes.
        const later =
          paused &&
          (before
            ? config.events === "new_and_changed" &&
              (before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) &&
              stat.mtimeMs > paused.after &&
              stat.mtimeMs <= observedAt
            : (stat.birthtimeMs > paused.after && stat.birthtimeMs <= observedAt) ||
              (config.events === "new_and_changed" &&
                stat.mtimeMs > paused.after &&
                stat.mtimeMs <= observedAt));
        if (!later) entries.push(entry);
        else if (before) entries.push(before);
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (after.dev !== info.dev || after.ino !== info.ino) throw new Error("watch_root_changed");
  }
  await visit(root, 0);
  signal.throwIfAborted();
  return {
    entries: entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    at: new Date(now).toISOString(),
    complete: true,
  };
}
export function snapshotChanges(
  previous: FolderTriggerState["snapshot"],
  next: NonNullable<FolderTriggerState["snapshot"]>,
  changed: boolean,
) {
  if (!previous?.complete) return [];
  const old = new Map(previous.entries.map((entry) => [entry.relativePath, entry]));
  return next.entries
    .filter((entry) => {
      const before = old.get(entry.relativePath);
      return (
        !before || (changed && (before.size !== entry.size || before.mtimeMs !== entry.mtimeMs))
      );
    })
    .map((entry) => entry.relativePath);
}
