import type { Logger } from "@pibot/observability";

/** A bounded sample, owned by one brain; never retain parameters or user identifiers. */
export function firstRpcDiagnostics(logger: Pick<Logger, "info">) {
  let readyAt: number | undefined;
  let expected = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reported = false;
  const lag: number[] = [];
  const rpcs: { method: string; startMs: number; durationMs?: number }[] = [];
  const report = () => {
    clearInterval(timer);
    if (readyAt === undefined || reported) return;
    reported = true;
    logger.info(
      JSON.stringify({
        module: "startup",
        event: "brain_first_rpcs",
        windowMs: Math.round(performance.now() - readyAt),
        intervalMs: 50,
        lagMs: lag,
        rpcs,
      }),
    );
  };
  return {
    ready() {
      readyAt = performance.now();
      expected = readyAt + 50;
      timer = setInterval(() => {
        const now = performance.now();
        lag.push(Math.round(Math.max(0, now - expected)));
        expected = now + 50;
        if (now - (readyAt ?? now) >= 5000) report();
      }, 50);
      timer.unref();
    },
    begin(method: string) {
      if (readyAt === undefined || reported || rpcs.length >= 32) return () => {};
      const started = performance.now();
      const row = {
        method,
        startMs: Math.round(started - readyAt),
        durationMs: undefined as number | undefined,
      };
      rpcs.push(row);
      return () => {
        row.durationMs = Math.round(performance.now() - started);
      };
    },
    stop: report,
  };
}
