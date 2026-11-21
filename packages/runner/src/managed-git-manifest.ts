import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { createGitReader } from "@pibot/execution";

/** Manifest digest of a path the commit deletes (no content to check on the control side). */
export const DELETED = "0".repeat(64);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Paths of `git status --porcelain=v2 -z --no-renames` (the reader's status op). Header lines are
 * skipped; an unmerged entry refuses the commit instead of committing conflict markers.
 */
export function changedPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\0")) {
    if (!line || line.startsWith("# ") || line.startsWith("! ")) continue;
    if (line.startsWith("? ")) paths.push(line.slice(2));
    else if (line.startsWith("1 ")) paths.push(afterFields(line, 8));
    else if (line.startsWith("u ")) throw new Error("managed_git_conflicted");
    else throw new Error("managed_git_status_unavailable");
  }
  return paths;
}
function afterFields(line: string, count: number) {
  let index = -1;
  for (let field = 0; field < count; field++) {
    index = line.indexOf(" ", index + 1);
    if (index < 0) throw new Error("managed_git_status_unavailable");
  }
  return line.slice(index + 1);
}

/**
 * What a commit would take, for the control side to check before it binds the hash to execute
 * (the redactor and the secrets table stay on the control side). Same limits as a local
 * group commit: 500 paths, 5 MiB per file, 32 MiB in all; links and non-files are refused.
 */
export async function commitManifest(
  reader: ReturnType<typeof createGitReader>,
  root: string,
  signal: AbortSignal,
) {
  const result = await reader.run(
    { op: "status" },
    { cwd: root, signal, maxBytes: 2 * 1024 * 1024 },
  );
  if (result.exitCode !== 0 || result.overflow) throw new Error("managed_git_status_unavailable");
  const names = changedPaths(result.stdout.toString("utf8"));
  if (names.length > MAX_FILES) throw new Error("managed_git_file_limit");
  let total = 0;
  const entries: { path: string; size: number; sha256: string }[] = [];
  for (const name of names) {
    signal.throwIfAborted();
    const path = join(root, name);
    const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    // A deleted path stays in the manifest so the hash binds it; the zero digest marks it.
    if (!info) {
      entries.push({ path: name, size: 0, sha256: DELETED });
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1n)
      throw new Error("managed_git_file_unsupported");
    const size = Number(info.size);
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES)
      throw new Error("managed_git_file_limit");
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error("managed_git_file_limit");
    const sha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    entries.push({ path: name, size, sha256 });
  }
  const filesHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { entries, filesHash };
}
