import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { sameFile } from "../core/file-identity.ts";
import { ExecError, type FileContext } from "../core/types.ts";

export interface SearchFileContext extends FileContext {
  /** Supplied by brain, under the original search approval; false never opens another prompt. */
  authorizePath(path: string, kind: "directory" | "file", signal: AbortSignal): Promise<boolean>;
}
export interface DirectoryIdentity {
  path: string;
  // Bigint: number inodes lose precision on NTFS and would let two nearby folders compare equal.
  info: BigIntStats;
}
/**
 * Why a search stopped early. "time_limit" is the search's own deadline: the caller still gets
 * what was found, because one slow walk must not discard matches the model already paid for.
 */
export type SearchTruncation = "results" | "scan_limit" | "byte_limit" | "time_limit";

// Hidden development caches were consuming all 20,000 entries before source files were visited.
// Explicitly searching inside one of these roots still works; implicit recursion skips them.
export const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".pibot",
  "node_modules",
  "__pycache__",
  "venv",
  "env",
  "dist",
  "out",
  "build",
  "target",
  "coverage",
  "vendor",
  "bower_components",
]);
export const SOURCE_HIDDEN_DIRECTORIES = new Set([
  ".github",
  ".gitlab",
  ".storybook",
  ".changeset",
]);
const MAX_VISITED = 20_000;
export const MAX_DEPTH = 64;

/** The one rule for which subfolders implicit recursion enters; the rg engine re-applies it. */
export function skippedDirectory(name: string) {
  return (
    SKIPPED_DIRECTORIES.has(name) || (name.startsWith(".") && !SOURCE_HIDDEN_DIRECTORIES.has(name))
  );
}

export function skippableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EBUSY"].includes(String(error.code))
  );
}
export function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return sameFile(a, b) && a.mode === b.mode;
}
export async function checkedDirectory(
  path: string,
  signal: AbortSignal,
  expected?: BigIntStats,
): Promise<DirectoryIdentity> {
  signal.throwIfAborted();
  const info = await lstat(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (expected && !sameIdentity(info, expected)) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new ExecError("outside_workplace");
  signal.throwIfAborted();
  return { path, info };
}

export async function walkFiles(
  root: DirectoryIdentity,
  options: SearchFileContext,
  // A synchronous return lets a caller queue the file for later instead of doing the work inline.
  visit: (
    path: string,
    name: string,
    parent: DirectoryIdentity,
  ) => SearchTruncation | undefined | Promise<SearchTruncation | undefined>,
  descend?: (name: string) => boolean,
): Promise<{ truncated?: SearchTruncation; skippedUnreadable: number }> {
  const { signal } = options;
  const queue = [{ ...root, depth: 0 }];
  let visited = 0,
    cursor = 0,
    skippedUnreadable = 0;
  let truncated: SearchTruncation | undefined;
  while (cursor < queue.length) {
    signal.throwIfAborted();
    const directory = queue[cursor++] as DirectoryIdentity & { depth: number };
    if (!(await options.authorizePath(directory.path, "directory", signal))) continue;
    try {
      await checkedDirectory(directory.path, signal, directory.info);
      const handle = await opendir(directory.path);
      // for-await closes the directory on every break, error, cancellation, and early return.
      for await (const entry of handle) {
        signal.throwIfAborted();
        if (++visited > MAX_VISITED) return { truncated: "scan_limit", skippedUnreadable };
        const full = join(directory.path, entry.name);
        if (entry.isDirectory()) {
          if (skippedDirectory(entry.name)) continue;
          // A caller may prune impossible glob branches, never replace authorization.
          if (descend && !descend(relative(root.path, full).split(sep).join("/"))) continue;
          if (directory.depth >= MAX_DEPTH) {
            truncated = "scan_limit";
            continue;
          }
          try {
            await checkedDirectory(directory.path, signal, directory.info);
            queue.push({ ...(await checkedDirectory(full, signal)), depth: directory.depth + 1 });
          } catch (error) {
            signal.throwIfAborted();
            if (!skippableError(error)) throw error;
            skippedUnreadable++;
          }
        } else if (entry.isFile()) {
          const stop = await visit(full, relative(root.path, full).split(sep).join("/"), directory);
          if (stop) return { truncated: stop, skippedUnreadable };
        }
        // Symlinks and special files are never traversed, opened, or returned as regular files.
      }
      await checkedDirectory(directory.path, signal, directory.info);
    } catch (error) {
      signal.throwIfAborted();
      if (!skippableError(error)) throw error;
      skippedUnreadable++;
    }
  }
  return { truncated, skippedUnreadable };
}
