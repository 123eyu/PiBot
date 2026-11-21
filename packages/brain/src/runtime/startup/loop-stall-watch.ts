import type { Logger } from "@pibot/observability";

const RECENT_MARKS = 12;

/**
 * The brain runs every chat, group step and Git read on one thread. In the v0.0.3 Windows
 * acceptance it stalled for about 9 s and the only trace was other timers firing late, so a long
 * gap between ticks is logged with the last few phase marks. Marks are fixed identifiers (RPC
 * method names, session-open steps); `agoMs` is how long before the stall was noticed each one
 * was set, so the mark that precedes the gap names the work that held the thread.
 */
export function watchBrainLoop(
  logger: Pick<Logger, "warn">,
  intervalMs = 250,
  thresholdMs = 1_000,
) {
  const marks: { phase: string; at: number }[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - intervalMs;
    last = now;
    if (lag < thresholdMs) return;
    logger.warn(
      JSON.stringify({
        module: "brain",
        event: "event_loop_stall",
        ms: Math.round(lag),
        recent: marks.map((mark) => ({ phase: mark.phase, agoMs: Math.round(now - mark.at) })),
      }),
    );
  }, intervalMs);
  timer.unref();
  return {
    mark(phase: string) {
      marks.push({ phase, at: performance.now() });
      if (marks.length > RECENT_MARKS) marks.shift();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
