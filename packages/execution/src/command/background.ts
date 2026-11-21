import { ExecError } from "../core/types.ts";
import { createBackgroundStarter } from "./background/job.ts";
import { createBackgroundMonitor } from "./background/monitor.ts";
import {
  backgroundCleanupReason,
  createBackgroundProcesses,
  groupAlive,
} from "./background/processes.ts";
import type {
  BackgroundDependencies,
  BackgroundDrainEvent,
  BackgroundJob,
  BackgroundProcessRecord,
  Job,
} from "./background/types.ts";

export type {
  BackgroundCallbacks,
  BackgroundDrainEvent,
  BackgroundEndReason,
  BackgroundJob,
  BackgroundProcessRecord,
} from "./background/types.ts";

/**
 * A cleanup that could not be confirmed stops new commands, so waiting for a restart is not an
 * option: the retained process groups are checked again on this interval.
 */
const RETRY_MS = 30_000;

/** Log a still-blocked retry once in this many attempts; a stuck group stays quiet otherwise. */
const REPORT_EVERY = 10;

interface RetainedDrain {
  reason: BackgroundDrainEvent["reason"];
  /** Captured when the failure happened: the retained job may end before the retry runs. */
  records: BackgroundProcessRecord[];
  /** Every job whose cleanup was never confirmed; a second failure while paused joins this set. */
  jobIds: string[];
  attempts: number;
  /** Bumped when another failure joins; a retry that started earlier must not release the pause. */
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Records are merged by tree identity so the same group is never checked or killed twice. */
const recordKey = (record: BackgroundProcessRecord) =>
  `${record.group}:${record.processes
    .map((process) => `${process.pid}:${process.started}`)
    .sort()
    .join(",")}`;

/** Instance owner; monitor and jobs retain their resources until real drain succeeds. */
export function createBackgroundJobs(deps: BackgroundDependencies) {
  const jobs = new Map<string, Job>();
  const lifetime = new AbortController();
  let drainFailure: ExecError | undefined;
  let drain: RetainedDrain | undefined;
  let retrying: Promise<void> | undefined;
  const monitor = createBackgroundMonitor(deps, jobs, lifetime);
  const processes = createBackgroundProcesses(deps);
  const report = (event: BackgroundDrainEvent) => {
    try {
      deps.onDrain?.(event);
    } catch {
      // A health sink must never decide whether the pause is released.
    }
  };
  const assertHealthy = () => {
    if (drainFailure) throw drainFailure;
  };
  const schedule = () => {
    if (!drain || lifetime.signal.aborted) return;
    clearTimeout(drain.timer);
    const timer = setTimeout(() => {
      if (drain) drain.timer = undefined;
      retrying = retry().finally(() => {
        retrying = undefined;
        // Recovery clears `drain`; anything else is still blocked and tries again later.
        schedule();
      });
    }, RETRY_MS);
    // The retry is a safety net, not a reason to keep the process alive.
    timer.unref?.();
    drain.timer = timer;
  };
  /** Re-check the retained groups; the pause stays until an attempt proves nothing is left. */
  async function retry() {
    const current = drain;
    if (!current || lifetime.signal.aborted) return;
    const revision = current.revision;
    current.attempts += 1;
    // Proof needs something to check: on POSIX the retained group id, on Windows the recorded
    // process identities. Without either, a restart stays the only way out.
    const provable =
      current.records.length > 0 &&
      (deps.platform !== "win32" || current.records.every((record) => record.processes.length > 0));
    let remaining = provable ? 0 : 1;
    try {
      if (provable) {
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(RETRY_MS)]);
        remaining = await processes.killOrphans(current.records, signal);
        remaining += groupAlive(current.records, deps.platform);
      }
    } catch {
      // A failed snapshot proves nothing either way, so the pause continues.
      remaining = 1;
    }
    if (lifetime.signal.aborted) return;
    // Another failure joined while this attempt was running: its tree has not been checked yet,
    // so releasing the pause here would strand it exactly like the first one was stranded.
    if (drain !== current || current.revision !== revision) return;
    const jobId = current.jobIds.length === 1 ? { jobId: current.jobIds[0] } : {};
    if (remaining) {
      if (current.attempts === 1 || current.attempts % REPORT_EVERY === 0)
        report({
          phase: "retrying",
          reason: current.reason,
          ...jobId,
          attempts: current.attempts,
          remaining,
        });
      return;
    }
    // Confirmed clean: release the pause first, then end the one job that never finished cleanup.
    drainFailure = undefined;
    drain = undefined;
    clearTimeout(current.timer);
    for (const id of current.jobIds) {
      const abandoned = jobs.get(id);
      if (abandoned?.running)
        void abandoned.finish("failed").catch(() => {
          // The proof above is what matters; a failed log close is reported by the next cleanup.
        });
    }
    report({
      phase: "recovered",
      reason: current.reason,
      ...jobId,
      attempts: current.attempts,
      remaining: 0,
    });
  }
  const failDrain = (error: ExecError, jobId?: string, record?: BackgroundProcessRecord) => {
    // Only the tree whose cleanup failed is retained; other background commands keep running and
    // must never be killed by the retry or ended by the recovery.
    // The failed job is read regardless of `running`: a reported failure may already have marked
    // it stopped. Without an identifiable tree the pause cannot be proven clear, so it stays.
    const failed = jobId ? jobs.get(jobId) : undefined;
    const retained = failed ? [failed.record()] : record ? [record] : [];
    // A failure while already paused is a different tree, not the same state: dropping it would
    // let the first recovery release the pause with this tree unchecked.
    const joined = drain;
    if (joined) {
      const seen = new Set(joined.records.map(recordKey));
      for (const candidate of retained) {
        const key = recordKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        joined.records.push(candidate);
      }
      if (jobId && !joined.jobIds.includes(jobId)) joined.jobIds.push(jobId);
      // A retry may be mid-flight with the older set; its release must be refused.
      joined.revision += 1;
      report({
        phase: "paused",
        reason: joined.reason,
        ...(jobId ? { jobId } : {}),
        attempts: joined.attempts,
        remaining: 0,
      });
      return;
    }
    drainFailure = error;
    drain = {
      reason: backgroundCleanupReason(error),
      records: retained,
      jobIds: jobId ? [jobId] : [],
      attempts: 0,
      revision: 0,
    };
    report({
      phase: "paused",
      reason: drain.reason,
      ...(jobId ? { jobId } : {}),
      attempts: 0,
      remaining: 0,
    });
    schedule();
  };
  const start = createBackgroundStarter({
    ...deps,
    lifetime,
    assertHealthy,
    failDrain,
    terminate: processes.terminate,
    added(job) {
      jobs.set(job.id, job);
      monitor.schedule(50);
    },
    removed(job) {
      jobs.delete(job.id);
      monitor.removed();
    },
    rootExited: monitor.reschedule,
  });
  return {
    start,
    activeCount: () => [...jobs.values()].filter((job) => job.running).length,
    assertHealthy,
    failDrain,
    drainFailed: () => !!drainFailure,
    killOrphans: processes.killOrphans,
    get(id: string): BackgroundJob | undefined {
      return jobs.get(id);
    },
    async dispose() {
      lifetime.abort();
      clearTimeout(drain?.timer);
      drain = undefined;
      const monitoring = monitor.dispose();
      const results = await Promise.allSettled([...jobs.values()].map((job) => job.stop()));
      await retrying;
      await monitoring;
      if (drainFailure || results.some((result) => result.status === "rejected"))
        throw drainFailure ?? new ExecError("command_failed", "cleanup_failed");
    },
  };
}
