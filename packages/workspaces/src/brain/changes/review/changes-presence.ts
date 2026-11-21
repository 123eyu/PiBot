import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Bounded so the first command of a run in a huge folder (a home folder, a monorepo) waits at
 * most this long; breadth-first, so the shallow levels where tools create their temp trees are
 * covered first. Measured on an M-series Mac: a 32k-entry checkout (node_modules / .git skipped)
 * ~130 ms; a folder that reaches the entry cap ~0.5 s.
 */
const SCAN_ENTRIES = 50_000;
const SCAN_MS = 800;
const PARALLEL = 16;

/** What a folder held before a run's first command there. */
export interface FolderPresence {
  /** What was at `rel` before; undefined when the listing did not reach it. */
  before(rel: string): "absent" | "file" | "folder" | undefined;
  /**
   * The target a link at `rel` pointed at before the run, as written in the link. It lets callers
   * tell a link the sandbox re-created from one the turn actually wrote or repointed.
   */
  beforeLink(rel: string): string | undefined;
  files: ReadonlyMap<string, string>;
}

/**
 * The folder watch only says "something happened at this path" (FSEvents / ReadDirectoryChangesW
 * through fs.watch report neither creation nor removal), so a path that is gone at the end of the
 * turn could be a deleted original or a test's temp file created and removed again. This listing,
 * taken before the first command can change anything, tells the two apart. A directory counts as
 * scanned only when all its entries were recorded, so "not in the listing" is a reliable "absent".
 */
export async function scanPresence(
  root: string,
  ignore: (rel: string) => boolean,
  signal: AbortSignal,
  limits: { entries: number; ms: number } = { entries: SCAN_ENTRIES, ms: SCAN_MS },
  signatures = false,
): Promise<FolderPresence> {
  /** Relative path → whether it was a folder. */
  const entries = new Map<string, boolean>();
  /** Relative path → link target, for the entries that are links. */
  const links = new Map<string, string>();
  const files = new Map<string, string>();
  const listed = new Set<string>();
  const deadline = performance.now() + limits.ms;
  const open = () => !signal.aborted && performance.now() < deadline;
  let level = [""];
  while (level.length && open()) {
    const next: string[] = [];
    for (let start = 0; start < level.length && open(); start += PARALLEL)
      await Promise.all(
        level.slice(start, start + PARALLEL).map(async (dir) => {
          const items = await readdir(dir ? join(root, ...dir.split("/")) : root, {
            withFileTypes: true,
          }).catch(() => undefined);
          // Unreadable or over budget: its entries stay "unknown" rather than "absent".
          if (!items || entries.size + items.length > limits.entries || !open()) return;
          for (const item of items) {
            const rel = dir ? `${dir}/${item.name}` : item.name;
            if (ignore(rel)) continue;
            // Symbolic links are not followed: the watch does not follow them either.
            entries.set(rel, item.isDirectory());
            if (signatures && (item.isFile() || item.isSymbolicLink())) {
              const info = await lstat(join(root, ...rel.split("/"))).catch(() => undefined);
              if (info)
                files.set(
                  rel,
                  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`,
                );
            }
            if (item.isSymbolicLink()) {
              const target = await readlink(join(root, ...rel.split("/"))).catch(() => undefined);
              if (target !== undefined) links.set(rel, target);
            }
            if (item.isDirectory()) next.push(rel);
          }
          listed.add(dir);
        }),
      );
    level = next;
  }
  return {
    files,
    before(rel) {
      const parts = rel.split("/");
      // The nearest scanned ancestor decides: its listing names the next component or it doesn't.
      for (let depth = parts.length - 1; depth >= 0; depth--) {
        if (!listed.has(parts.slice(0, depth).join("/"))) continue;
        const folder = entries.get(parts.slice(0, depth + 1).join("/"));
        if (folder === undefined) return "absent";
        if (depth + 1 === parts.length) return folder ? "folder" : "file";
        // An unlisted folder on the way (over budget), or a file that became a folder.
        return folder ? undefined : "absent";
      }
      return undefined;
    },
    beforeLink(rel) {
      return entries.has(rel) ? links.get(rel) : undefined;
    },
  };
}

/** A command-observed path that still belongs in the turn. */
export interface ObservedPath {
  path: string;
  /** False when the path is gone and the "before" listing did not reach it: listed last. */
  known: boolean;
}

/**
 * The watched paths (relative, "/"-separated) that belong in the turn: files that exist now, and
 * vanished paths unless the listing shows they did not exist before (created and removed within
 * the turn, such as a test run's temp tree or a shell's here-document file).
 */
export async function observedPaths(
  root: string,
  rels: string[],
  presence: FolderPresence | undefined,
): Promise<ObservedPath[]> {
  const kept: ObservedPath[] = [];
  // Sorted, a folder precedes its contents: once it is known gone, its whole tree is skipped
  // without a file-system call (a test's temp tree can hold thousands of paths).
  const gone = new Set<string>();
  const inGone = (rel: string) => {
    for (let at = rel.indexOf("/"); at > 0; at = rel.indexOf("/", at + 1))
      if (gone.has(rel.slice(0, at))) return true;
    return false;
  };
  for (const rel of rels.sort()) {
    if (rel === ".") continue;
    const path = join(root, ...rel.split("/"));
    const info = inGone(rel) ? undefined : await lstat(path).catch(() => undefined);
    if (info) {
      // Folder events are reported too; only files (or files that vanished) belong in the turn.
      if (info.isFile() || info.isSymbolicLink()) kept.push({ path, known: true });
      continue;
    }
    gone.add(rel);
    // A removed folder's files are reported one by one; the folder itself is not a file change.
    const before = presence?.before(rel);
    if (before === "file" || before === undefined) kept.push({ path, known: !!before });
  }
  return kept;
}
