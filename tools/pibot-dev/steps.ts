import { randomUUID } from "node:crypto";
import { packageMac, testMac } from "./app.ts";
import { exceptionReason } from "./check-failure.ts";
import { now, record } from "./context.ts";
import { packageLog } from "./mac-package.ts";
import { macTestLog } from "./mac-test.ts";
import type { StepRecord, TaskRecord } from "./state.ts";
import { ensureElectronAsync } from "./windows/electron.ts";
import { testWin } from "./windows.ts";
import { changeSet } from "./worktree.ts";

/* Release steps after review: package, app tests, finish. */

const out = (text: string) => process.stdout.write(`${text}\n`);

export { current, finish } from "./release-task.ts";

export async function packageTask(task: TaskRecord, signal?: AbortSignal) {
  const current = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(45 * 60_000),
  ]);
  const runId = randomUUID();
  const receipt: StepRecord = {
    step: "package",
    at: now(),
    runId,
    outcome: "harness_failed",
    detail: "package_in_progress",
    log: packageLog(runId),
  };
  try {
    record(task.id, receipt);
  } catch {
    throw new Error("Package receipt unavailable");
  }
  try {
    current.throwIfAborted();
    receipt.diffDigest = changeSet(task).digest;
    const run = await packageMac(task, current, runId);
    Object.assign(receipt, {
      outcome: run.outcome,
      detail: run.detail,
      log: run.log,
      durationMs: run.durationMs,
      ...(run.artifact ? { artifact: run.artifact } : {}),
    });
    // Deliver queued OS signals before committing a terminal success and removing CLI listeners.
    await new Promise<void>((resolve) => setImmediate(resolve));
    current.throwIfAborted();
    if (changeSet(task).digest !== receipt.diffDigest) throw new Error("package_source_changed");
  } catch (error) {
    receipt.outcome = "harness_failed";
    receipt.detail =
      receipt.detail === "package_cleanup_unconfirmed"
        ? "package_cleanup_unconfirmed"
        : current.aborted
          ? "workflow_cancelled"
          : error instanceof Error && error.message === "package_source_changed"
            ? "source_changed"
            : error instanceof Error && /^package_[a-z_]{1,80}$/.test(error.message)
              ? error.message
              : exceptionReason(error);
  }
  receipt.at = now();
  try {
    record(task.id, receipt);
  } catch {
    throw new Error("Package receipt unavailable");
  }
  out(`package ${receipt.outcome}: ${receipt.detail}; receipt ${receipt.log}`);
  if (receipt.outcome !== "ok") throw new Error("Package validation failed");
}

export async function testMacTask(task: TaskRecord, args: string[], signal?: AbortSignal) {
  const receipt: StepRecord = {
    step: "test-mac",
    at: now(),
    runId: randomUUID(),
    outcome: "harness_failed",
    detail: "mac_test_in_progress",
  };
  receipt.log = macTestLog(receipt.runId as string);
  // Persist before any preflight: a crash/exception cannot leave an earlier success as latest.
  try {
    record(task.id, receipt);
  } catch {
    throw new Error("Mac test receipt unavailable");
  }
  let failure: unknown;
  let shots: string | undefined;
  try {
    signal?.throwIfAborted();
    receipt.diffDigest = changeSet(task).digest;
    const result = await testMac(
      task,
      ["smoke", ...args.filter((arg) => !arg.startsWith("--"))],
      undefined,
      signal,
      receipt.runId,
    );

    receipt.artifact = result.artifact;
    shots = result.shots;
    signal?.throwIfAborted();
    if (changeSet(task).digest !== receipt.diffDigest) throw new Error("mac_test_source_changed");
    receipt.outcome = result.ok ? "ok" : "failed";
    receipt.detail = result.results
      .map((row) => `${row.flow}:${row.ok ? "ok" : "failed"}`)
      .join(" ");
  } catch (error) {
    failure = error;
    receipt.outcome = "harness_failed";
    receipt.detail = signal?.aborted
      ? "workflow_cancelled"
      : error instanceof Error && error.name === "TimeoutError"
        ? "workflow_timeout"
        : error instanceof Error && error.message === "mac_test_source_changed"
          ? "source_changed"
          : error instanceof Error && /^(?:mac_test|cdp)_[a-z_]{1,80}$/.test(error.message)
            ? error.message
            : exceptionReason(error);
  }
  receipt.at = now();
  try {
    record(task.id, receipt);
  } catch {
    throw new Error("Mac test receipt unavailable");
  }
  out(`test-mac ${receipt.outcome}: ${receipt.detail}; receipt ${receipt.log}`);
  if (receipt.outcome === "ok" && shots) out(`screenshots ${shots}`);
  if (failure || receipt.outcome !== "ok") throw new Error("Mac validation failed");
}

export async function testWinTask(task: TaskRecord, checks: string[] = [], signal?: AbortSignal) {
  const current = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(60 * 60_000),
  ]);
  const receipt: StepRecord = {
    step: "test-win",
    at: now(),
    outcome: "harness_failed",
    detail: "windows_workflow_incomplete",
  };
  try {
    current.throwIfAborted();
    const allowed = ["first-screen", "backend-ready", "app-window"] as const;
    if (checks.some((check) => !allowed.includes(check as (typeof allowed)[number])))
      throw new Error("Unknown Windows check");
    const digest = changeSet(task).digest;
    receipt.diffDigest = digest;
    await ensureElectronAsync(task.worktree, { signal: current });
    const result = await testWin(task, {
      sourceDigest: digest,
      signal: current,
      checks: checks as (typeof allowed)[number][],
    });
    Object.assign(receipt, {
      log: result.log,
      runId: result.runId,
      artifactHash: result.artifactHash,
      stages: result.stages,
    });
    const changed = changeSet(task).digest !== digest;
    receipt.outcome = current.aborted
      ? "harness_failed"
      : changed
        ? "harness_failed"
        : result.outcome;
    receipt.detail = current.aborted
      ? signal?.aborted
        ? "workflow_cancelled"
        : "workflow_timeout"
      : changed
        ? "source_changed"
        : result.detail;
  } catch (error) {
    receipt.outcome = "harness_failed";
    receipt.detail = current.aborted
      ? signal?.aborted
        ? "workflow_cancelled"
        : "workflow_timeout"
      : error instanceof Error && error.message === "windows_receipt_write_failed"
        ? "windows_receipt_write_failed"
        : exceptionReason(error);
  }
  try {
    record(task.id, receipt);
  } catch {
    receipt.outcome = "harness_failed";
    receipt.detail = "windows_state_receipt_write_failed";
    try {
      record(task.id, receipt);
    } catch {
      out("test-win harness_failed: windows_failure_receipt_unavailable");
      throw new Error("Windows failure receipt unavailable");
    }
  }
  out(`test-win ${receipt.outcome}: ${receipt.detail}`);
  if (receipt.outcome !== "ok" && receipt.outcome !== "skipped")
    throw new Error("Windows validation failed");
}
