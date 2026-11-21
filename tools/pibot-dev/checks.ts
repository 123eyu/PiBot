import { execFileSync } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { changeFingerprint, readCheckPass } from "../dev/change-fingerprint.ts";
import {
  type CheckFailure,
  classifyFailure,
  exceptionReason,
  safeExcerpt,
} from "./check-failure.ts";
import { pnpmEnv, runLogged, store } from "./context.ts";
import { acquireDirectoryLock } from "./operation-lock.ts";
import type { TaskRecord } from "./state.ts";
import { assertVerifyRecoverable } from "./verify-lock.ts";

const HOUR = 60 * 60 * 1000;
/** verify's acceptance stage labels → the script that runs that suite alone. */
export const ACCEPTANCE: Record<string, string> = {
  chat: "acceptance:chat",
  routines: "acceptance:routines",
  "connected-app": "acceptance:connected-app",
  "group-plan": "acceptance:group-plan",
};

/** Waits for a stale-check rerun: the Bot's own run already takes 10+ minutes under load. */
const CHECK_CHANGED_TIMEOUT_MS = 45 * 60_000;

/** What a verify needs: a name for the lock, logs and rerun scripts, plus the tree to run in. */
export type VerifyTarget = Pick<TaskRecord, "id" | "worktree">;

export interface VerifyResult {
  ok: boolean;
  log: string;
  durationMs: number;
  /** Failing step labels (from verify's last line). */
  failed: string[];
  failure?: CheckFailure;
  /** Bounded, redacted beginning and end of the failing output. */
  excerpt: string;
  /** Acceptance suites that failed inside verify but passed when rerun alone. */
  flaky: string[];
}

/** The output of the failing steps: prefixed lines for parallel stages, the stage block otherwise. */
export function excerptOf(text: string, failed: string[]) {
  const lines = text.split("\n");
  const prefixed = lines.filter((line) => failed.some((label) => line.startsWith(`[${label}] `)));
  let picked = prefixed;
  if (!picked.length) {
    const end = lines.findIndex((line) => line.startsWith("── ") && line.includes(": FAILED"));
    const start = lines.slice(0, Math.max(end, 0)).findLastIndex((line) => line.startsWith("── "));
    picked = lines.slice(start + 1, end < 0 ? undefined : end);
  }
  // The first diagnostic is often the cause; the tail carries the final summary.
  return safeExcerpt(picked.join("\n"));
}

interface CheckChangedResult {
  /**
   * "fresh": the recorded pass is about exactly this work and nothing ran; "passed" / "failed":
   * the workflow reran the check because the worktree changed after the Bot's last passing run.
   */
  state: "fresh" | "passed" | "failed" | "harness_failed";
  failure?: CheckFailure;
  /** Failing step labels from check:changed's closing line. */
  failed: string[];
  /** What the Bot gets back on failure: the failing stage and the tail of its output. */
  excerpt: string;
  log?: string;
  durationMs?: number;
}

/**
 * `pnpm check:changed` only describes the work it ran on. A turn that kept editing after
 * its check still ended 待审 with that stale pass, so verify was the first to see a task's three
 * type errors, 8 unformatted files and boundary break. The workflow recomputes the fingerprint the
 * check recorded and runs the check again when the work moved on.
 */
export function checkChanged(task: VerifyTarget): CheckChangedResult {
  const started = Date.now();
  try {
    return checkChangedUnlocked(task);
  } catch (error) {
    return {
      state: "harness_failed",
      failure: { kind: "harness", reason: exceptionReason(error) },
      failed: [],
      excerpt: "",
      durationMs: Date.now() - started,
    };
  }
}

function checkChangedUnlocked(task: VerifyTarget): CheckChangedResult {
  const work = changeFingerprint(task.worktree);
  if (readCheckPass(task.worktree)?.digest === work.digest)
    return { state: "fresh", failed: [], excerpt: "" };
  const run = runLogged(task.id, "check-changed", "pnpm", ["check:changed"], {
    cwd: task.worktree,
    timeoutMs: CHECK_CHANGED_TIMEOUT_MS,
    env: pnpmEnv,
  });
  if (run.ok)
    return { state: "passed", failed: [], excerpt: "", log: run.log, durationMs: run.durationMs };
  const text = run.text();
  const failed = [
    ...(/check:changed: (.*)$/m.exec(text)?.[1] ?? "").matchAll(/([\w.:-]+) failed/g),
  ].map((match) => match[1] as string);
  const failure = classifyFailure(run, text, failed);
  return {
    state: failure.kind === "harness" ? "harness_failed" : "failed",
    failure,
    failed,
    excerpt: run.timedOut
      ? `check:changed timed out after ${Math.round(CHECK_CHANGED_TIMEOUT_MS / 60_000)} min`
      : excerptOf(text, failed),
    log: run.log,
    durationMs: run.durationMs,
  };
}

/**
 * One full verify at a time (machine-wide, across pibot-dev processes): two verifies beside the
 * dev Bot's checks kept load above 100 on 16 cores and timed out the real-time acceptance
 * scenarios (2026-11-05). Tasks still run in parallel; only verify queues.
 */
function withVerifyLock<T>(_task: VerifyTarget, run: () => T): T {
  const lock = join(store.dir, "verify.lock");
  let release: (() => void) | undefined;
  for (let waited = 0; ; waited++) {
    assertVerifyRecoverable(lock);
    try {
      release = acquireDirectoryLock(lock, () => assertVerifyRecoverable(lock));
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error.message !== "Operation busy" && (error as NodeJS.ErrnoException).code !== "EEXIST")
      )
        throw error;
      if (waited === 0) process.stdout.write("pibot-dev: waiting for another verify to finish\n");
      execFileSync("sleep", ["15"]);
    }
  }
  try {
    return run();
  } finally {
    release();
  }
}

export function verify(task: VerifyTarget): VerifyResult {
  const started = Date.now();
  try {
    return withVerifyLock(task, () => verifyUnlocked(task));
  } catch (error) {
    return {
      ok: false,
      log: "",
      durationMs: Date.now() - started,
      failed: [],
      excerpt: "",
      flaky: [],
      failure: {
        kind: "harness",
        reason:
          error instanceof Error && error.message === "verify_cleanup_unconfirmed"
            ? "process_cleanup_unconfirmed"
            : exceptionReason(error),
      },
    };
  }
}

function verifyUnlocked(task: VerifyTarget): VerifyResult {
  const run = runLogged(task.id, "verify", "pnpm", ["verify"], {
    cwd: task.worktree,
    timeoutMs: 2 * HOUR,
    env: pnpmEnv,
  });
  const text = run.text();
  if (run.ok)
    return {
      ok: true,
      log: run.log,
      durationMs: run.durationMs,
      failed: [],
      excerpt: "",
      flaky: [],
    };
  const failed = [
    ...(/verify: Error: (.*)$/m.exec(text)?.[1] ?? "").matchAll(/([\w-]+) failed \(/g),
  ].map((match) => match[1] as string);
  const result: VerifyResult = {
    ok: false,
    log: run.log,
    durationMs: run.durationMs,
    failed,
    failure: failed.some(
      (label) =>
        !["install", "check", "build", "smoke", "workflows", ...Object.keys(ACCEPTANCE)].includes(
          label,
        ),
    )
      ? { kind: "harness", reason: "unclassified_check_failure" }
      : classifyFailure(run, text, failed),
    excerpt: run.timedOut ? "verify timed out after 2 hours" : excerptOf(text, failed),
    flaky: [],
  };
  // The acceptance suites run real-time scenarios side by side; under machine load one can miss
  // its phase deadline (2026-11-04: routines, then 18/18 alone). Rerun only those, once, alone.
  if (
    result.failure?.kind === "harness" ||
    !failed.length ||
    !failed.every((label) => ACCEPTANCE[label])
  )
    return result;
  for (const label of failed) {
    // A rerun right away met the same load (2026-11-05: load 400, two different routines
    // scenarios missed their deadlines in a row). Wait for the machine to calm down, twice at most.
    let passed = false;
    for (let attempt = 0; attempt < 2 && !passed; attempt++) {
      calm();
      const retry = runLogged(task.id, `verify-${label}`, "pnpm", [ACCEPTANCE[label] as string], {
        cwd: task.worktree,
        timeoutMs: HOUR,
        env: pnpmEnv,
      });
      passed = retry.ok;
      if (!passed) {
        const failure = classifyFailure(retry, retry.text(), [label]);
        if (failure.kind === "harness")
          return { ...result, failure, log: retry.log, excerpt: excerptOf(retry.text(), []) };
      }
    }
    if (!passed) return result;
    result.flaky.push(label);
  }
  // The stage after acceptance never ran.
  const rest = runLogged(task.id, "verify-workflows", "pnpm", ["eval", "workflows"], {
    cwd: task.worktree,
    timeoutMs: HOUR,
    env: pnpmEnv,
  });
  if (!rest.ok)
    return {
      ...result,
      failed: ["workflows"],
      failure: classifyFailure(rest, rest.text(), ["workflows"]),
      log: rest.log,
      excerpt: excerptOf(rest.text(), []),
      flaky: result.flaky,
    };
  return { ...result, ok: true, failure: undefined, failed: [], excerpt: "" };
}

/** Waits (20 minutes at most) until the 1-minute load average is below the core count. */
function calm() {
  const deadline = Date.now() + 20 * 60 * 1000;
  while ((loadavg()[0] ?? 0) > availableParallelism() && Date.now() < deadline) {
    process.stdout.write(`pibot-dev: load ${Math.round(loadavg()[0] ?? 0)}; waiting to rerun\n`);
    execFileSync("sleep", ["60"]);
  }
}
