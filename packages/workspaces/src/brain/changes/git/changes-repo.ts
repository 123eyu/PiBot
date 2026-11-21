import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ExecError, type GitReader, validGitIdentity } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import type { GitIdentity } from "@pibot/workspaces-contract/full";
import { changesError } from "../changes-scope.ts";

export interface RepoInfo {
  toplevel: string;
  gitDir: string;
  commonDir: string;
  /** Diff base before the first commit. */
  emptyTree: string;
  /** .git (and its common dir) live inside the folder, so sandboxed writes can reach them. */
  layoutOk: boolean;
  /**
   * The folder's "/" separated location when the repository root is above it. Reads are
   * then scoped to the folder and writes refused; null when the folder is the repository root.
   */
  subdirectory: string | null;
}
export type RepoProbe =
  | { state: "repo"; info: RepoInfo }
  | { state: "none"; reason: "not_repo" | "git_unavailable" };
type Platform = "darwin" | "linux" | "win32";

/**
 * The error for a write or read that needs a repository. Git missing is its own code, so the
 * panel offers the install card instead of calling a known repository "not a repository".
 */
export function notRepoError(probe: Extract<RepoProbe, { state: "none" }>) {
  return changesError(
    probe.reason === "git_unavailable" ? "changes_git_unavailable" : "changes_not_repo",
  );
}

const emptyTrees: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

/** Maps reader failures to the protocol's codes; cancellation keeps its own path. */
export async function read<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ExecError && error.code === "git_unavailable")
      throw changesError("changes_git_unavailable");
    throw error;
  }
}

export async function probeRepo(
  reader: GitReader,
  root: string,
  platform: Platform,
  signal: AbortSignal,
): Promise<RepoProbe> {
  let result: Awaited<ReturnType<GitReader["run"]>>;
  try {
    result = await reader.run({ op: "probe" }, { cwd: root, signal, timeoutMs: 10_000 });
  } catch (error) {
    if (error instanceof ExecError && error.code === "git_unavailable")
      return { state: "none", reason: "git_unavailable" };
    throw error;
  }
  if (result.exitCode !== 0) return { state: "none", reason: "not_repo" };
  const [top, gitDir, commonDir, format, prefix = ""] = result.stdout.toString("utf8").split("\n");
  if (!top || !gitDir || !commonDir) return { state: "none", reason: "not_repo" };
  const toplevel = await realpath(top);
  const subdirectory = prefix.replace(/\/+$/, "") || null;
  // Git's view must land exactly on the folder; a repository whose core.worktree points elsewhere
  // would otherwise make reads cover files outside it.
  const expected = subdirectory ? join(toplevel, ...subdirectory.split("/")) : toplevel;
  if (!containsPath(expected, root, platform) || !containsPath(root, expected, platform))
    return { state: "none", reason: "not_repo" };
  const [git, common] = await Promise.all([realpath(gitDir), realpath(commonDir)]);
  return {
    state: "repo",
    info: {
      toplevel,
      gitDir: git,
      commonDir: common,
      emptyTree: emptyTrees[format ?? "sha1"] ?? (emptyTrees.sha1 as string),
      layoutOk:
        !subdirectory && containsPath(root, git, platform) && containsPath(root, common, platform),
      subdirectory,
    },
  };
}

/** While merging or rebasing the sidebar is view-only. */
export async function repoOperation(gitDir: string) {
  const exists = (name: string) =>
    access(join(gitDir, name), constants.F_OK).then(
      () => true,
      () => false,
    );
  const [merge, rebaseMerge, rebaseApply, pick, revert] = await Promise.all(
    ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].map(exists),
  );
  if (rebaseMerge || rebaseApply) return "rebase" as const;
  if (merge) return "merge" as const;
  if (pick) return "cherry-pick" as const;
  if (revert) return "revert" as const;
  return null;
}

/** The identity Git itself would use for `git commit` here (repo, then global, then system). */
export async function readIdentity(
  reader: GitReader,
  cwd: string,
  signal: AbortSignal,
): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all(
    (["user.name", "user.email"] as const).map((key) =>
      reader.run({ op: "config", key }, { cwd, signal, timeoutMs: 5_000, maxBytes: 4096 }),
    ),
  );
  if (name?.exitCode !== 0 || email?.exitCode !== 0) return null;
  const value = {
    name: name.stdout.toString("utf8").trim(),
    email: email.stdout.toString("utf8").trim(),
  };
  return validGitIdentity(value.name, value.email) ? value : null;
}

/**
 * Untracked files have no numstat; count lines directly. Bounded per file and never following a
 * link, so a planted symlink cannot make the brain read outside the folder.
 */
export async function countLines(root: string, path: string, platform: Platform) {
  const absolute = join(root, ...path.split("/"));
  try {
    const parent = await realpath(dirname(absolute));
    if (!containsPath(root, parent, platform)) return { added: null, removed: null, binary: false };
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return { added: 1, removed: 0, binary: false };
    if (!info.isFile() || info.size > 1024 * 1024)
      return { added: null, removed: null, binary: false };
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await file.readFile();
      if (bytes.subarray(0, 8000).includes(0)) return { added: null, removed: null, binary: true };
      let lines = 0;
      for (const byte of bytes) if (byte === 10) lines++;
      if (bytes.length && bytes[bytes.length - 1] !== 10) lines++;
      return { added: lines, removed: 0, binary: false };
    } finally {
      await file.close();
    }
  } catch {
    // Vanished or unreadable files only lose their count; the list itself stays correct.
    return { added: null, removed: null, binary: false };
  }
}
