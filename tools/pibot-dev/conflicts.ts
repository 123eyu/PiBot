import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { git } from "./context.ts";

const MARKER_TEXT_LIMIT = 2 * 1024 * 1024;
const unmergedFiles = (wt: string) =>
  git(wt, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);

/** Pin a normal file before reading: links are Git blobs, never content-scanning authorities. */
function markerBytes(worktree: string, file: string): Buffer | undefined {
  const parts = file.split("/");
  if (isAbsolute(file) || parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid conflict scan path");
  const parents: { path: string; dev: number; ino: number }[] = [];
  let path = worktree;
  try {
    for (const part of ["", ...parts.slice(0, -1)]) {
      path = part ? join(path, part) : path;
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      parents.push({ path, dev: stat.dev, ino: stat.ino });
    }
    const target = join(worktree, file);
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MARKER_TEXT_LIMIT) return;
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        throw new Error("Conflict scan file changed before open");
      for (const parent of parents) {
        const current = lstatSync(parent.path);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== parent.dev ||
          current.ino !== parent.ino
        )
          throw new Error("Conflict scan parent changed before read");
      }
      if (opened.size > MARKER_TEXT_LIMIT) return;
      const bytes = Buffer.alloc(MARKER_TEXT_LIMIT + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      return length <= MARKER_TEXT_LIMIT ? bytes.subarray(0, length) : undefined;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return;
    throw error;
  }
}

/** Files that still carry Git's conflict markers at the start of a line. */
export function conflictMarkedFiles(worktree: string, files: string[]) {
  const marked: string[] = [];
  for (const file of files) {
    const buffer = markerBytes(worktree, file);
    if (!buffer || buffer.includes(0)) continue;
    if (/^(?:<<<<<<< |>>>>>>> )/m.test(buffer.toString("utf8"))) marked.push(file);
  }
  return marked;
}

/** Refuse unresolved index entries or actual worktree file markers before review and release. */
export function assertNoConflicts(worktree: string, files: string[]) {
  const bad = [...new Set([...unmergedFiles(worktree), ...conflictMarkedFiles(worktree, files)])];
  if (bad.length)
    throw new Error(
      `${worktree} 里有 ${bad.length} 个文件带冲突标记或未合并条目：${bad.join("、")}；先解决冲突再继续`,
    );
}
