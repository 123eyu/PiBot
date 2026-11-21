import type { Logger } from "@pibot/observability";

/**
 * Wall time of each awaited step of a desktop process's startup, logged once as
 * `{module:"startup", event, totalMs, sinceProcessMs, phases}`. Fixed phase identifiers and
 * milliseconds only; never paths or content. Mirrors the brain's own ready line.
 */
export interface MainStartupTiming {
  mark(name: string, atMs?: number): void;
  report(logger: Pick<Logger, "info">, event: string): void;
}

const phaseName = /^[a-z][a-z0-9_.-]{0,63}$/;

export function createMainStartupTiming(): MainStartupTiming {
  // Measured from process start: app.whenReady and module evaluation are part of the wait.
  let last = 0;
  const phases: Record<string, number> = {};
  const intervals: { name: string; startMs: number; endMs: number }[] = [];
  return {
    mark(name, atMs) {
      const at = atMs ?? performance.now();
      const key = phaseName.test(name) ? name : "invalid";
      phases[key] = (phases[key] ?? 0) + Math.round(at - last);
      intervals.push({ name: key, startMs: Math.round(last), endMs: Math.round(at) });
      last = at;
    },
    report(logger, event) {
      const now = Math.round(performance.now());
      logger.info(
        JSON.stringify({
          module: "startup",
          event,
          platform: process.platform,
          totalMs: now,
          sinceProcessMs: now,
          phases,
          intervals,
        }),
      );
    },
  };
}
