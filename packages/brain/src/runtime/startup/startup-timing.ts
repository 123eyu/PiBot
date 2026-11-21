import type { Logger } from "@pibot/observability";

/**
 * Wall time of every awaited startup phase, logged once when the brain is ready, so a
 * slow launch on a real data directory says where the time went. Only phase names (fixed
 * identifiers) and milliseconds are recorded; never paths, counts of user data or content.
 */
export interface StartupTiming {
  /** Closes the phase that began at the previous mark (or at creation) under `name`. */
  mark(name: string): void;
  /** The last closed phase, so a liveness signal can say where startup got to. */
  lastPhase(): string;
  /** Logs `{module:"startup", event, totalMs, sinceProcessMs, phases}` at info level. */
  report(logger: Pick<Logger, "info">, event?: string): void;
}

const phaseName = /^[a-z][a-z0-9_.-]{0,63}$/;

export function createStartupTiming(now: () => number = () => performance.now()): StartupTiming {
  const started = now();
  let last = started;
  let closed = "module";
  // Insertion order is phase order; a repeated name accumulates (e.g. one per capability start).
  const phases: Record<string, number> = {};
  const intervals: { name: string; startMs: number; endMs: number }[] = [];
  return {
    mark(name) {
      const at = now();
      // A non-identifier name is a programming error, but timing must never fail startup.
      const key = phaseName.test(name) ? name : "invalid";
      phases[key] = (phases[key] ?? 0) + Math.round(at - last);
      intervals.push({ name: key, startMs: Math.round(last), endMs: Math.round(at) });
      last = at;
      closed = key;
    },
    lastPhase() {
      return closed;
    },
    report(logger, event = "ready") {
      logger.info(
        JSON.stringify({
          module: "startup",
          event,
          totalMs: Math.round(now() - started),
          // Process uptime includes module evaluation of the bundle before startBrain ran.
          sinceProcessMs: Math.round(performance.now()),
          phases,
          intervals,
        }),
      );
    },
  };
}
