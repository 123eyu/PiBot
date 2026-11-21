import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertNoConflicts } from "./conflicts.ts";
import { git } from "./context.ts";
import type { TaskRecord } from "./state.ts";

export interface ChangeEntry {
  path: string;
  mode: string;
  hash: string | null;
}
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
export function gitBytes(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], {
    maxBuffer: 256 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function exactText(bytes: Buffer) {
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes) ? text : `base64:${bytes.toString("base64")}`;
}
function paths(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Non-UTF8 Git paths need manual review");
  return text.split("\0").filter(Boolean);
}
export function workingEntry(worktree: string, path: string): ChangeEntry {
  const parts = path.split("/");
  if (
    isAbsolute(path) ||
    parts.some((part) => part === ".." || part === ".") ||
    path.includes("\0")
  )
    throw new Error("Invalid Git entry path");
  // Git treats tracked children of a replaced directory as deleted, never follow the new link.
  let parent = worktree;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    try {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        return { path, mode: "deleted", hash: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { path, mode: "deleted", hash: null };
      throw error;
    }
  }
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(join(worktree, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, mode: "deleted", hash: null };
    throw error;
  }
  if (info.isSymbolicLink())
    return {
      path,
      mode: "120000",
      hash: hash(readlinkSync(join(worktree, path), { encoding: "buffer" })),
    };
  if (!info.isFile()) throw new Error("Unsupported changed entry; inspect the worktree manually");
  const indexed = /^(\d+) /.exec(git(worktree, "ls-files", "-s", "--", path))?.[1];
  const filemode =
    git(worktree, "config", "--get", "--default", "true", "core.filemode") !== "false";
  const mode = filemode ? (info.mode & 0o111 ? "100755" : "100644") : (indexed ?? "100644");
  return { path, mode, hash: hash(readFileSync(join(worktree, path))) };
}
export function committedEntry(worktree: string, oid: string, path: string): ChangeEntry {
  const row = gitBytes(worktree, "ls-tree", "-z", oid, "--", path).toString("utf8");
  if (!row) return { path, mode: "deleted", hash: null };
  const mode = /^(\d+) blob ([a-f0-9]+)\t/.exec(row);
  if (!mode) throw new Error("Unsupported committed entry");
  return {
    path,
    mode: mode[1] as string,
    hash: hash(gitBytes(worktree, "cat-file", "blob", mode[2] as string)),
  };
}

/** V2 gates include the baseline and exact bytes/mode of every changed path, including deletion. */
export function changeSet(task: Pick<TaskRecord, "worktree">, baseOverride?: string) {
  const wt = task.worktree;
  const baseOid = baseOverride ?? git(wt, "merge-base", "main", "HEAD");
  if (!/^[a-f0-9]{40,64}$/.test(baseOid)) throw new Error("Invalid source baseline OID");
  const tracked = paths(gitBytes(wt, "diff", "--no-renames", "--name-only", "-z", baseOid));
  const untracked = paths(gitBytes(wt, "ls-files", "--others", "--exclude-standard", "-z"));
  const files = [...new Set([...tracked, ...untracked])].sort();
  assertNoConflicts(wt, files);
  const entries = files.map((path) => workingEntry(wt, path));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const digest = `v2:${hash(JSON.stringify({ baseOid, entries }))}`;
  const text = [
    `source-digest: ${digest}\nbase-oid: ${baseOid}\n${JSON.stringify(entries, null, 2)}`,
    exactText(
      gitBytes(wt, "diff", "--no-renames", "--no-color", "--binary", "--full-index", baseOid),
    ),
    ...untracked.sort().map((path) => {
      const entry = byPath.get(path);
      const bytes =
        entry?.mode === "120000"
          ? readlinkSync(join(wt, path), { encoding: "buffer" })
          : readFileSync(join(wt, path));
      if (bytes.length > 256 * 1024 * 1024)
        throw new Error("New file exceeds the full review snapshot limit");
      const preview =
        bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)
          ? `base64:${bytes.toString("base64")}`
          : bytes.toString("utf8");
      return `\n=== new file ${path}\n${preview}`;
    }),
  ].join("\n");
  if (JSON.stringify(files.map((path) => workingEntry(wt, path))) !== JSON.stringify(entries))
    throw new Error("Source changed while preparing the review snapshot");
  return { baseOid, entries, files, untracked, text, digest, legacyDigest: digest };
}

/** Runtime Markdown and root rules are product inputs; only actual documentation is exempt. */
export const docsOnly = (files: string[]) =>
  files.length > 0 &&
  files.every(
    (file) => file.startsWith("docs/") && file.endsWith(".md") && !file.endsWith("/SKILL.md"),
  );
