/**
 * The background process's main thread serves the brain, the window and the Bot browser at once.
 * A stall there (maintainers 2026-11-18: reading x.com) showed up only as timeouts elsewhere, so a long
 * gap between ticks is logged with its length; nothing about pages or chats is recorded.
 */
export function watchMainLoop(
  logger: { warn(message: string): void },
  intervalMs = 1_000,
  thresholdMs = 2_000,
) {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - intervalMs;
    last = now;
    if (lag >= thresholdMs)
      logger.warn(
        JSON.stringify({
          module: "background-main",
          event: "main_thread_stall",
          ms: Math.round(lag),
        }),
      );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
