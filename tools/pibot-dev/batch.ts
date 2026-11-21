import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { type VerifyResult, verify } from "./checks.ts";
import { git, now, pnpmEnv, record, repo, taskOf } from "./context.ts";
import type { TaskRecord } from "./state.ts";
import { current } from "./steps.ts";
import {
  changeSet,
  ensureElectron,
  hasMergeHead,
  resolveNotes,
  snapshotWorktree,
  syncMain,
} from "./worktree.ts";

const out = (text: string) => process.stdout.write(`${text}\n`);
const USAGE = "pibot-dev batch <id> <id> [...]";

/**
 * One full verify for several approved tasks at once. verify takes 16–35 minutes and
 * only one runs at a time, so eight approved tasks queued about three hours per merge round.
 *
 * Why verifying the combination also covers the single merges: `finish` merges tasks into main one
 * after another, so the last one to finish faces a main that already holds all earlier ones —
 * exactly a prefix of the combination merged here, in the same order. A task whose merge conflicts
 * outside docs is left out (its own `test` runs it); every kept task was merged here without code
 * conflicts, so each prefix of the combination has a real counterpart on main. `finish` still syncs
 * main and requires a review bound to its current digest, so if new main commits make a merge
 * different, that task needs a new review instead of this verify record.
 */
export async function batchTasks(args: string[]) {
  const ids = args.filter((arg) => !arg.startsWith("--"));
  if (ids.length < 2) throw new Error(`usage: ${USAGE}`);
  // Bound to the digest like `test`: a verify recorded for code no review covers would let
  // `finish` merge unreviewed changes.
  const approved = ids.map((id) => {
    const task = taskOf(id, USAGE);
    if (syncMain(task)) out(`pibot-dev: merged main into ${task.branch}`);
    const changes = changeSet(task);
    if (current(task, "review", changes)?.outcome !== "ok")
      throw new Error(
        `${task.id} has no review:pass for its current diff; run pibot-dev review ${task.id} first`,
      );
    return { task, digest: changes.digest };
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const batch = `batch-${stamp}`;
  const worktree = resolve(repo, "..", "PiBot-wt", `pibot-${batch}`);
  // Detached from main so the batch verifies "main plus these tasks", not either task branch.
  git(repo, "worktree", "add", "--detach", "-q", worktree, "main");
  const merged: { task: TaskRecord; digest: string }[] = [];
  let result: VerifyResult | undefined;
  try {
    for (const entry of approved) if (mergeInto(worktree, entry.task)) merged.push(entry);
    if (merged.length < 2)
      throw new Error(
        `only ${merged.length} task(s) merge cleanly; run pibot-dev test <id> on each instead`,
      );
    // Install after merging, not before: a task may change package.json / pnpm-lock.yaml, and the
    // merged tree must get those dependencies and that Electron version's binary. A fresh worktree
    // has no node_modules, so ensureElectron finds nothing to complete until this install ran
    // (verify's own install stage left Electron without the binary).
    execFileSync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: worktree,
      stdio: "inherit",
      env: pnpmEnv,
    });
    ensureElectron(worktree);
    out(
      `batch ${batch}: verifying ${merged.length} task(s) together, ${approved.length - merged.length} left out`,
    );
    result = verify({ id: batch, worktree });
  } finally {
    try {
      git(repo, "worktree", "remove", "--force", worktree);
    } catch (error) {
      // The batch's outcome matters more than the cleanup: report a leftover path, do not fail on it.
      out(`batch: could not remove ${worktree} (${String(error).slice(0, 200)})`);
    }
  }
  if (!result.ok)
    throw new Error(
      `batch verify failed: ${result.failed.join(", ") || "unknown"}; log ${result.log}`,
    );
  const flaky = result.flaky.length ? ` (flaky, passed alone: ${result.flaky.join(", ")})` : "";
  for (const { task, digest } of merged) {
    // A Bot still editing while verify ran would otherwise get an "ok" for code nobody verified.
    if (changeSet(task).digest !== digest) {
      out(
        `batch: ${task.id} changed during the batch; not recorded, run pibot-dev test ${task.id}`,
      );
      continue;
    }
    record(task.id, {
      step: "verify",
      at: now(),
      outcome: "ok",
      detail: `passed in ${batch} (${merged.length} tasks)${flaky}`,
      durationMs: result.durationMs,
      diffDigest: digest,
      log: result.log,
    });
  }
  out(
    `batch verify passed in ${Math.round(result.durationMs / 60000)} min${flaky}; each task goes on to package / test-mac / test-win / finish`,
  );
}

/**
 * Merges one task's snapshot commit and reports whether the batch now holds it. Docs-only
 * conflicts keep both sides (every task appends to the same notes); any other conflict aborts the
 * merge and leaves the task out.
 */
function mergeInto(worktree: string, task: TaskRecord) {
  const sha = snapshotWorktree(task.worktree, `pibot-dev snapshot of ${task.task} for a batch`);
  try {
    git(worktree, "merge", "-q", "--no-edit", sha);
    return true;
  } catch (error) {
    const unmerged = git(worktree, "diff", "--name-only", "--diff-filter=U")
      .split("\n")
      .filter(Boolean);
    // No unmerged paths: the merge never started (bad object, git identity, …). Do not call that
    // a task conflict and leave the task out silently.
    if (!unmerged.length) throw error;
    if (resolveNotes(worktree)) {
      git(worktree, "add", "-A", "docs");
      git(worktree, "-c", "core.editor=true", "commit", "-q", "--no-edit");
      return true;
    }
    if (hasMergeHead(worktree)) git(worktree, "merge", "--abort");
    out(`batch: ${task.id} conflicts outside docs; left out — run pibot-dev test ${task.id}`);
    return false;
  }
}
