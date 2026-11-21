import type { Logger } from "@pibot/observability";

/** A Bot browser action slower than this logs where its time went. */
const SLOW_MS = 2000;

export type Mark = (phase: string) => void;

/**
 * Splits one host action into named phases. The owner's logs only had a total per tool, which
 * could not tell a page that kept loading from a capture that waited out its budget. Phase names
 * are fixed identifiers and the values are milliseconds: no addresses, page text or ids.
 */
export function actionPhases() {
  const started = performance.now();
  let last = started;
  const phases: Record<string, number> = {};
  const mark: Mark = (phase) => {
    const now = performance.now();
    phases[phase] = (phases[phase] ?? 0) + Math.round(now - last);
    last = now;
  };
  return {
    mark,
    report(logger: Pick<Logger, "info">, method: string, extra: Record<string, unknown> = {}) {
      const totalMs = Math.round(performance.now() - started);
      if (totalMs < SLOW_MS) return;
      logger.info(
        JSON.stringify({
          module: "browser-host",
          event: "slow_action",
          method,
          totalMs,
          phases,
          ...extra,
        }),
      );
    },
  };
}
