import type { Logger } from "@pibot/observability";

/** Drift survives a stalled main thread and is emitted when that thread can run again. */
export function monitorMainEventLoop(logger: Pick<Logger, "warn">) {
  let expected = performance.now() + 1000;
  const timer = setInterval(() => {
    const now = performance.now();
    const delayMs = Math.round(now - expected);
    expected = now + 1000;
    if (delayMs >= 500)
      logger.warn(
        JSON.stringify({
          module: "host",
          event: "event_loop_delay",
          delayMs,
        }),
      );
  }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}
