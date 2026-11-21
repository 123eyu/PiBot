/** Runner reconnects retire a session, never the process-level execution owner. */
export function runnerRetryDelay(attempt: number) {
  return [1000, 2000, 5000, 10_000, 30_000, 60_000][Math.min(attempt, 5)] ?? 60_000;
}

export function waitRunnerRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** The error is an ownership handoff, not permission to abandon unfinished operations. */
export class RunnerDrainError extends Error {
  constructor(readonly retry: () => Promise<void>) {
    super("runner_session_drain_failed");
  }
}

export function resumeRunnerDrain(error: unknown) {
  return error instanceof RunnerDrainError ? error.retry() : Promise.resolve();
}

/** Pending calls survive cancellation/deadlines; only rejected calls may be retried. */
export function createRunnerDrain(
  cleanups: (() => void | Promise<void>)[],
  signal: AbortSignal,
  warn: (incomplete?: readonly { index: number; state: "idle" | "pending" }[]) => void,
) {
  const operations = cleanups.map((invoke) => ({
    invoke,
    state: "idle" as "idle" | "pending" | "done",
    pending: undefined as Promise<void> | undefined,
  }));
  let failures = 0;
  let running: Promise<void> | undefined;
  const run = async () => {
    const expires = Date.now() + 5000;
    while (operations.some((op) => op.state !== "done")) {
      for (const op of operations) {
        if (op.state !== "idle") continue;
        op.state = "pending";
        op.pending = Promise.resolve()
          .then(op.invoke)
          .then(
            () => {
              op.state = "done";
            },
            (error: unknown) => {
              // A lower layer may have failed before returning its session handle.
              if (error instanceof RunnerDrainError) op.invoke = error.retry;
              op.state = "idle";
            },
          );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      let abort = () => {};
      try {
        await Promise.race([
          Promise.all(operations.map((op) => op.pending)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, expires - Date.now()));
            // Allow normal asynchronous close acknowledgements a short, bounded cancellation grace.
            abort = () => {
              abortTimer ??= setTimeout(resolve, 250);
            };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally {
        clearTimeout(timer);
        clearTimeout(abortTimer);
        signal.removeEventListener("abort", abort);
      }
      if (operations.every((op) => op.state === "done")) return;
      if (failures++ % 30 === 0)
        warn(
          operations.flatMap((op, index) =>
            op.state === "done" ? [] : [{ index, state: op.state }],
          ),
        );
      if (signal.aborted || Date.now() >= expires) throw new RunnerDrainError(drain);
      await waitRunnerRetry(Math.min(1000, expires - Date.now()), signal);
    }
  };
  const drain = () => {
    running ??= run().finally(() => {
      running = undefined;
    });
    return running;
  };
  return drain;
}

export function drainRunnerConnection(
  cleanups: (() => void | Promise<void>)[],
  signal: AbortSignal,
  warn: () => void,
) {
  return createRunnerDrain(cleanups, signal, warn)();
}
