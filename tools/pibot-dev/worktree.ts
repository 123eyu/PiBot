import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearTscCache, writeTscCacheState } from "../dev/tsc-cache.ts";
import { assertNoConflicts, conflictMarkedFiles } from "./conflicts.ts";
import { git, pnpmEnv, repo, store } from "./context.ts";
import type { TaskRecord } from "./state.ts";

/**
 * Brings main into the task branch before review and test rounds, so both see the code the task
 * will merge into (a pilot task described a function main had changed meanwhile). The Bot's
 * uncommitted work is stashed around the merge; a conflict stops for Claude.
 */
export function syncMain(task: TaskRecord) {
  const wt = task.worktree;
  // A conflict the Bot has not resolved yet keeps its unmerged index entries; stashing those again
  // fails with "could not write index" and hides the real state. Refuse until `resolve`.
  if (task.syncConflict) throw new SyncConflictError(task.syncConflict.files, wt);
  try {
    git(wt, "merge-base", "--is-ancestor", "main", "HEAD");
    return false;
  } catch {
    // main has commits the branch lacks.
  }
  const dirty = git(wt, "status", "--porcelain") !== "";
  if (dirty) git(wt, "stash", "push", "-u", "-q", "-m", "pibot-dev sync");
  try {
    git(wt, "merge", "-q", "--no-edit", "main");
  } catch (error) {
    // Tasks started from a snapshot of an unmerged task conflict with main only in the notes both
    // appended to (CODEMAP, progress notes; two tasks on 2026-11-05): keep both and commit.
    if (!resolveNotes(wt))
      throw new Error(
        `main does not merge cleanly into ${task.branch} (${unmergedFiles(wt).join("、") || "see git status"}); resolve in ${wt} (work is in git stash)`,
        { cause: error },
      );
    git(wt, "add", "-A", "docs");
    git(wt, "-c", "core.editor=true", "commit", "-q", "--no-edit");
  }
  if (dirty) {
    try {
      git(wt, "stash", "pop", "-q");
    } catch (error) {
      if (!keepBothInNotes(wt)) {
        // A pop can also fail without leaving unmerged paths (an untracked file in the way); that
        // is a plain error, not a conflict resolved by editing files.
        if (!unmergedFiles(wt).length)
          throw new Error(`stash pop failed in ${wt}; work is still in git stash`, {
            cause: error,
          });
        throw recordSyncConflict(task, error);
      }
    }
  }
  // Checked even after a pop git reported as successful: it has left `UU` entries behind before.
  if (unmergedFiles(wt).length) throw recordSyncConflict(task);
  // The merge moved HEAD and the merge-base, so the incremental build data no longer
  // describes these sources and tsc would answer "up to date" from the pre-merge declarations.
  resetTscCache(wt);
  return true;
}

/** Drops the incremental tsc data of a worktree and records the commits it now describes. */
function resetTscCache(wt: string) {
  clearTscCache(wt);
  writeTscCacheState(wt, {
    head: git(wt, "rev-parse", "HEAD"),
    base: git(wt, "merge-base", "HEAD", "main"),
  });
}

/**
 * A sync whose stash pop conflicted: the worktree holds `UU` files with `<<<<<<<` markers and the
 * stash that could not be applied. An earlier version let this pass as success, so the markers travelled into
 * a snapshot and the next sync failed on the unmerged index.
 */
export class SyncConflictError extends Error {
  constructor(
    readonly files: string[],
    readonly worktree: string,
    options?: ErrorOptions,
  ) {
    super(
      `同步 main 后有 ${files.length} 个文件冲突：${files.join("、")}；在 ${worktree} 里解决后再继续`,
      options,
    );
    this.name = "SyncConflictError";
  }
}

const unmergedFiles = (wt: string) =>
  git(wt, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);

/** Records the conflict on the task and returns the error to throw; the stash is left in place. */
function recordSyncConflict(task: TaskRecord, cause?: unknown) {
  const files = unmergedFiles(task.worktree);
  let stash: string | undefined;
  try {
    stash = git(task.worktree, "rev-parse", "stash@{0}");
  } catch {
    // No stash to drop: the pop itself failed before creating one.
  }
  store.update((state) => {
    const current = state.tasks[task.id];
    if (!current) return;
    current.status = "sync_conflict";
    current.syncConflict = { files, ...(stash ? { stash } : {}) };
  });
  return new SyncConflictError(files, task.worktree, { cause });
}

/**
 * Drops the stash whose commit is `sha` (`git stash drop` rejects a bare commit hash, and another
 * stash may have been pushed since). Returns false when it is already gone.
 */
function dropStash(wt: string, sha: string) {
  const entry = git(wt, "stash", "list", "--format=%gd %H")
    .split("\n")
    .find((line) => line.endsWith(sha));
  const ref = entry?.split(" ")[0];
  if (!ref) return false;
  git(wt, "stash", "drop", "-q", ref);
  return true;
}

/**
 * Clears what a resolved conflict left behind, after Claude merged it by hand: `git reset --
 * <files>` drops the unmerged index entries while keeping the resolved content, then the sync
 * stash goes. Refuses while markers remain, so a half-done resolution stays visible instead of
 * entering a change set or snapshot.
 */
export function clearSyncConflict(task: TaskRecord) {
  const conflict = task.syncConflict;
  if (!conflict) return false;
  const marked = conflictMarkedFiles(task.worktree, conflict.files);
  if (marked.length)
    throw new Error(
      `${task.worktree} 里还有冲突标记：${marked.join("、")}；冲突由 Claude 解决后运行 pibot-dev conflict-done ${task.id}，未合并状态先保留`,
    );
  git(task.worktree, "reset", "-q", "--", ...conflict.files);
  if (conflict.stash) dropStash(task.worktree, conflict.stash);
  store.update((state) => {
    const current = state.tasks[task.id];
    if (!current) return;
    delete current.syncConflict;
    if (current.status === "sync_conflict") current.status = "waiting_review";
  });
  return true;
}

/** Append-only docs where both sides of a conflict are notes to keep. */
const NOTE_FILES = /^docs\/(?:plans\/[^/]+\.md|progress-notes\/[^/]+\.md|CODEMAP\.md)$/;

/**
 * Resolves a stash-pop conflict that touches only append-only notes by keeping both sides, then
 * drops the stash. Any conflict in another file is left for Claude (returns false).
 */
function keepBothInNotes(wt: string) {
  if (!resolveNotes(wt)) return false;
  git(wt, "reset", "-q");
  git(wt, "stash", "drop", "-q");
  return true;
}

/** Keeps both sides of every conflict when only append-only notes conflict; false otherwise. */
export function resolveNotes(wt: string) {
  const conflicted = git(wt, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  if (!conflicted.length || !conflicted.every((file) => NOTE_FILES.test(file))) return false;
  const texts = new Map<string, string>();
  for (const file of conflicted) {
    const text = readFileSync(join(wt, file), "utf8").replace(
      /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm,
      (_, ours: string, theirs: string) => `${ours}${theirs}`,
    );
    if (/^(?:<<<<<<<|=======|>>>>>>>)( |$)/m.test(text)) return false;
    texts.set(file, text);
  }
  // Written only once every file resolved, so a refusal leaves the conflict as git left it.
  for (const [file, text] of texts) writeFileSync(join(wt, file), text);
  return true;
}

export { changeSet, docsOnly } from "./changes.ts";
export { assertNoConflicts, conflictMarkedFiles } from "./conflicts.ts";

/**
 * A worktree installed from the shared store gets Electron's package but not its downloaded
 * binary (`dist/`, `path.txt`): a pilot task's tests importing electron failed, and smoke/package
 * would too. The main tree has the same version built, so clone it (APFS clonefile: no extra
 * space); otherwise download it the documented way.
 */
export function ensureElectron(worktree: string) {
  const store = join(worktree, "node_modules", ".pnpm");
  if (!existsSync(store)) return;
  for (const dir of readdirSync(store).filter((name) => name.startsWith("electron@"))) {
    const target = join(store, dir, "node_modules", "electron");
    if (existsSync(join(target, "dist")) && existsSync(join(target, "path.txt"))) continue;
    const source = join(repo, "node_modules", ".pnpm", dir, "node_modules", "electron");
    if (existsSync(join(source, "dist")) && existsSync(join(source, "path.txt"))) {
      execFileSync("cp", ["-cR", join(source, "dist"), join(target, "dist")]);
      execFileSync("cp", ["-c", join(source, "path.txt"), join(target, "path.txt")]);
    } else
      execFileSync("pnpm", ["--filter", "@pibot/desktop", "exec", "install-electron"], {
        cwd: worktree,
        stdio: "inherit",
        env: { ...pnpmEnv, ELECTRON_GET_USE_PROXY: "1" },
      });
  }
}

/** Workspace roots that keep a tsc cache per package (pnpm-workspace.yaml). */
const CACHE_ROOTS = ["packages", "apps", "apps/plugins"];

/**
 * A task's first `check:changed` built every affected package from scratch and took 4-10
 * minutes, most of it `tsc -b`: a fresh worktree has no `.cache/tsc` (outDir + tsBuildInfoFile, see
 * packages/brain/tsconfig.json), while the main tree beside it already built the same projects.
 * tsc reuses a file only when its content and the compiler version match, and tsbuildinfo records
 * relative paths, so a copy into another tree can only save time: an entry that does not match is
 * recompiled, never trusted.
 */
export function seedBuildCache(worktree: string) {
  let copied = 0;
  for (const root of CACHE_ROOTS) {
    const base = join(repo, root);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const source = join(base, name, ".cache", "tsc");
      if (!existsSync(source)) continue;
      try {
        cpSync(source, join(worktree, root, name, ".cache", "tsc"), { recursive: true });
        copied++;
      } catch (error) {
        // Nothing needs the cache to start a task; tsc compiles whatever it cannot match. Keep the
        // reason visible (unreadable source, full disk) without failing the task over a speed-up.
        process.stderr.write(
          `pibot-dev: ${root}/${name} build cache not copied (${String(error).slice(0, 200)})\n`,
        );
      }
    }
  }
  // The copies describe the main tree's build, not this worktree's first commit: record which
  // commits they came from, so the first check:changed drops them if the worktree starts elsewhere
  // (from an unmerged snapshot) or after main has moved on.
  if (copied) {
    const head = git(repo, "rev-parse", "HEAD");
    writeTscCacheState(worktree, { head, base: head });
  }
  return copied;
}

/**
 * A commit of a task worktree's whole current state (tracked edits and new files), made with a
 * throwaway index so the Bot's worktree, index and branch stay untouched. A dependent task starts
 * from it: task branches carry no commits until finish, so `--base pibot/<task>` alone gave the
 * dependent an empty base (a dependent then tried to read its base's worktree, 2026-11-05).
 */
export function snapshotWorktree(worktree: string, message: string) {
  // A worktree stopped mid-merge (its chain waiting for Claude) carries conflict markers; one task
  // was snapshotted from another at exactly that moment and inherited nested markers in CODEMAP.
  const unmerged = git(worktree, "diff", "--name-only", "--diff-filter=U");
  if (unmerged || existsSync(join(worktree, ".git", "MERGE_HEAD")) || hasMergeHead(worktree))
    throw new Error(`--base worktree ${worktree} is in the middle of a merge; resolve it first`);
  // Markers can outlive an unmerged index (a Bot edited the file, `git add` was never run); a
  // snapshot must not hand them to a dependent task (one inherited its base's CODEMAP markers).
  assertNoConflicts(
    worktree,
    [
      ...git(worktree, "diff", "--name-only", "HEAD").split("\n"),
      ...git(worktree, "ls-files", "--others", "--exclude-standard").split("\n"),
    ].filter(Boolean),
  );
  // Outside the worktree, or `add -A` would snapshot the index file itself.
  const index = join(store.dir, `snapshot-${process.pid}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", env }).trim();
  try {
    run("read-tree", "HEAD");
    run("add", "-A");
    const tree = run("write-tree");
    return run("commit-tree", tree, "-p", "HEAD", "-m", message);
  } finally {
    rmSync(index, { force: true });
  }
}

/** A linked worktree keeps MERGE_HEAD under the main repository's .git/worktrees/<name>. */
export function hasMergeHead(worktree: string) {
  try {
    return existsSync(join(git(worktree, "rev-parse", "--git-dir"), "MERGE_HEAD"));
  } catch {
    // No git dir to inspect means no merge in progress there either.
    return false;
  }
}
