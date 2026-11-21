import type { Logger } from "@pibot/observability";
import type { CapabilityHandle } from "../../core/capability.ts";

/** Diagnostics never gate readiness; their owners must still drain before capability disposal. */
export function deferredMaintenance(logger: Logger) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  return {
    start(handles: readonly CapabilityHandle[], preload?: () => Promise<void>) {
      // First-screen RPCs follow ready by about 0.3 s; let them finish before CPU-heavy imports.
      timer = setTimeout(() => {
        timer = undefined;
        if (controller.signal.aborted) return;
        const jobs = handles.flatMap((handle) =>
          handle.afterReady ? [(signal: AbortSignal) => handle.afterReady?.(signal)] : [],
        );
        if (preload) jobs.push(preload);
        work = Promise.all(
          jobs.map(async (run, index) => {
            if (controller.signal.aborted) return;
            const start = performance.now();
            try {
              // Cooperative deadline for capability hooks. Native import ignores AbortSignal;
              // its module evaluation cannot be force-cancelled and stop must await it below.
              await run(AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
            } catch {
              if (!controller.signal.aborted)
                logger.warn(
                  JSON.stringify({
                    module: "startup",
                    event: "deferred_maintenance_failed",
                    index,
                  }),
                );
            } finally {
              if (!controller.signal.aborted)
                logger.info(
                  JSON.stringify({
                    module: "startup",
                    event: "deferred_maintenance_settled",
                    index,
                    durationMs: Math.round(performance.now() - start),
                  }),
                );
            }
          }),
        ).then(() => {});
      }, 2000);
      timer.unref();
    },
    async stop() {
      controller.abort();
      clearTimeout(timer);
      // Clearing the timer prevents new work; an in-flight native import must finish draining.
      await work;
    },
  };
}
