import type {
  BrainSleepBlockerSchema,
  BrainWakeReasonSchema,
  IndependentBackgroundState,
  WakePlan,
} from "@pibot/protocol";
import type { z } from "zod";
import type { createBrainWakeBridge } from "../brain/brain-wake-bridge.ts";
import { createLightWatches, type LightWatches } from "./background-light-watch.ts";

type Phase = NonNullable<IndependentBackgroundState["brainPhase"]>;
type Reason = z.infer<typeof BrainWakeReasonSchema>;
// In-flight runs, requests, approvals and automation hold a restart; "not_idle" and "upcoming"
// only matter for standby, and "unavailable" (no wake plan, unhealthy) is what a restart repairs.
const RESTART_BLOCKERS: ReadonlySet<z.infer<typeof BrainSleepBlockerSchema>> = new Set([
  "gui",
  "work",
  "requests",
  "approvals",
  "automation",
  "stopping",
  "stale",
  "budget",
]);

/** One lifecycle lane owns both expected retirement and cold launch. Stop closes it synchronously. */
export function createBackgroundSleepOwner(deps: {
  signal: AbortSignal;
  eligible(): boolean;
  hasBrain(): boolean;
  sleep(): ReturnType<typeof createBrainWakeBridge>;
  launch(signal: AbortSignal): Promise<void>;
  retire(): Promise<void>;
  changed(phase: Phase): void;
  failed(): void;
  watch?: typeof createLightWatches;
}) {
  let phase: Phase = "working";
  let revision = 0;
  let closed = false;
  let operation: Promise<void> | undefined;
  let preparing: AbortController | undefined;
  let watching: AbortController | undefined;
  let waking: Promise<void> | undefined;
  let watches: LightWatches | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingWake = false;
  let failures = 0;
  let retryAt = 0;
  let plan: WakePlan | undefined;
  const publish = (next: Phase) => {
    phase = next;
    deps.changed(next);
  };
  const clearWatches = () => {
    watching?.abort();
    watching = undefined;
    watches?.close();
    watches = undefined;
    plan = undefined;
  };
  const requestStop = () => {
    closed = true;
    revision++;
    preparing?.abort();
    clearTimeout(timer);
    clearWatches();
  };
  deps.signal.addEventListener("abort", requestStop, { once: true });
  const deadline = () => {
    const values = [plan?.nextAt, plan?.checksAt, plan?.pollAt]
      .filter((at): at is string => typeof at === "string")
      .map(Date.parse);
    if (watches?.pollAt) values.push(watches.pollAt);
    return Math.min(...values);
  };
  const fail = () => {
    publish("unavailable");
    retryAt = Date.now() + Math.min(1_800_000, 5000 * 2 ** Math.min(failures++, 9));
    deps.failed();
  };
  const launch = async () => {
    if (closed || deps.signal.aborted) return;
    publish("waking");
    await deps.launch(deps.signal);
    if (closed) return;
    failures = 0;
    retryAt = 0;
    clearWatches();
    publish("working");
  };
  const wakeInside = async (reason: Reason) => {
    if (closed) return;
    if (phase === "standby" || !deps.hasBrain()) return launch();
    if (phase === "working") return;
    // Unknown commit/restore outcomes never authorize reuse of an old writer.
    if (phase === "unavailable") {
      await deps.retire();
      if (!closed) await launch();
      return;
    }
    const result = await deps.sleep().report(deps.signal);
    if (closed) return;
    if (result.report.phase === "committed") {
      await deps.retire();
      if (!closed) await launch();
    } else {
      if (result.report.phase !== "working") await deps.sleep().resume(reason, deps.signal);
      clearWatches();
      publish("working");
    }
  };
  const lane = (action: () => Promise<void>) => {
    if (operation) return operation;
    const running = action();
    operation = running;
    void running
      .finally(() => {
        if (operation === running) operation = undefined;
        if (!closed && pendingWake && !waking) {
          pendingWake = false;
          void wake("timer").catch(() => {});
        } else arm();
      })
      .catch(() => {
        // The returned promise reports failure; only the derived finally rejection is consumed.
      });
    return running;
  };
  const wake = (reason: Reason): Promise<void> => {
    if (closed || deps.signal.aborted)
      return Promise.reject(new Error("background_owner_stopping"));
    if (phase === "unavailable" && Date.now() < retryAt && reason !== "gui" && reason !== "host") {
      arm();
      return Promise.reject(new Error("background_wake_backoff"));
    }
    revision++;
    preparing?.abort();
    clearTimeout(timer);
    if (operation) pendingWake = true;
    if (waking) return waking;
    const pending = (async () => {
      // Coalesce all wake callers behind a retirement, including commit whose reply is late.
      await operation?.catch(() => {});
      if (closed) throw new Error("background_owner_stopping");
      pendingWake = false;
      await lane(async () => {
        try {
          await wakeInside(reason);
        } catch (error) {
          if (!closed) fail();
          throw error;
        }
      });
    })();
    waking = pending;
    void pending
      .finally(() => {
        if (waking === pending) waking = undefined;
        if (!closed && pendingWake) {
          pendingWake = false;
          void wake("timer").catch(() => {});
        }
      })
      .catch(() => {});
    return pending;
  };
  const sleepInside = async () => {
    if (closed || !deps.eligible() || !deps.hasBrain()) return;
    const version = revision;
    const abort = new AbortController();
    preparing = abort;
    const signal = AbortSignal.any([deps.signal, abort.signal, AbortSignal.timeout(90_000)]);
    let attemptedCommit = false;
    try {
      const first = await deps.sleep().report(signal);
      if (!first.report.canSleep || !first.report.plan) return;
      signal.throwIfAborted();
      if (revision !== version || !deps.eligible()) return;
      publish("preparing");
      const observed = first.report.plan;
      watching = new AbortController();
      watches = await (deps.watch ?? createLightWatches)(
        observed,
        AbortSignal.any([deps.signal, watching.signal]),
        () => {
          void wake("folder").catch(() => {});
        },
      );
      signal.throwIfAborted();
      const prepared = await deps.sleep().prepare(observed, signal);
      signal.throwIfAborted();
      const ticket = prepared.ticket;
      const complete = prepared.report.plan;
      if (
        !ticket ||
        !complete ||
        prepared.report.phase !== "prepared" ||
        revision !== version ||
        !deps.eligible() ||
        JSON.stringify(complete.folders) !== JSON.stringify(observed.folders)
      )
        throw new Error("background_sleep_stale");
      await watches.verify(signal);
      signal.throwIfAborted();
      if (revision !== version || !deps.eligible()) throw new Error("background_sleep_stale");
      plan = complete;
      publish("prepared");
      attemptedCommit = true;
      const committed = await deps.sleep().commit(ticket, signal);
      if (!committed.committed || committed.report.phase !== "committed")
        throw new Error("background_sleep_not_committed");
      // An event after commit requires a cold launch; it cannot resume this utility.
      await deps.retire();
      if (closed) return;
      publish("standby");
      if (revision !== version || !deps.eligible()) pendingWake = true;
    } catch {
      if (closed) return;
      try {
        // Local cancellation/timeout cannot tell whether a commit arrived at the utility.
        const actual = await deps.sleep().report(deps.signal);
        if (actual.report.phase === "committed") {
          await deps.retire();
          if (!closed) {
            publish("standby");
            pendingWake = true;
          }
        } else {
          await deps.sleep().resume("cancel", deps.signal);
          if (!closed) publish("working");
        }
      } catch {
        if (!closed) fail();
      }
      if (attemptedCommit || phase !== "standby") clearWatches();
    } finally {
      preparing = undefined;
      // A successful watch set must outlive the request's timeout while the utility is absent.
      if (phase !== "standby") clearWatches();
    }
  };
  function arm() {
    clearTimeout(timer);
    if (closed) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (closed || operation) return;
        if (phase === "standby") {
          if (Date.now() >= deadline()) void wake("timer").catch(() => {});
          else arm();
        } else if (phase === "unavailable") {
          if (Date.now() >= retryAt) void wake("timer").catch(() => {});
          else arm();
        } else void lane(sleepInside).catch(() => {});
        // Standby fires at the planned (already early) deadline instead of up to 30s after it.
      },
      phase === "standby" ? Math.max(1000, Math.min(30_000, deadline() - Date.now())) : 30_000,
    );
    timer.unref();
  }
  return {
    get phase() {
      return phase;
    },
    start: arm,
    /**
     * A keyring recovery restart needs drained business work, not standby's idle window (three
     * quiet minutes, nothing due for ten): those rarely all hold at once, so recovery never came.
     * The restart itself is the ordinary owner stop, which retires a working utility as a quit does.
     */
    async prepareRestart(commit: () => boolean) {
      if (closed || operation || waking) return false;
      let accepted = false;
      await lane(async () => {
        if (closed) return;
        if (phase !== "standby" && deps.hasBrain()) {
          let report: Awaited<ReturnType<ReturnType<typeof deps.sleep>["report"]>>["report"];
          try {
            ({ report } = await deps
              .sleep()
              .report(AbortSignal.any([deps.signal, AbortSignal.timeout(30_000)])));
          } catch {
            // An unknown brain state only defers; it never authorizes the restart.
            return;
          }
          if (
            closed ||
            report.phase !== "working" ||
            report.blockers.some((blocker) => RESTART_BLOCKERS.has(blocker))
          )
            return;
        }
        // Commit must close admission synchronously, but must not await stop on this lane.
        accepted = commit();
      });
      return accepted;
    },
    wake,
    unavailable() {
      if (closed) return;
      revision++;
      preparing?.abort();
      fail();
      if (!operation) arm();
    },
    requestStop,
    async stop() {
      requestStop();
      await operation?.catch(() => {});
      await waking?.catch(() => {});
      await deps.retire();
      deps.signal.removeEventListener("abort", requestStop);
    },
  };
}
