/** How long one owned resource may take to dispose before teardown goes on without it. */
const DISPOSE_DEADLINE_MS = 10_000;

// Initialization and shutdown share one resource owner. A stop receipt closes admission
// synchronously; teardown waits until in-flight acquisition has handed back its resources.
export function createBackgroundOwnerLifecycle(options: {
  /** `failure` is the initialization error when startup itself failed and caused the stop. */
  requested(failure?: unknown): void;
  prepareStop(): Promise<void>;
  stopWriter(): Promise<void>;
  release(): Promise<void>;
  finish(): Promise<void>;
  failed(): void;
  /** A resource's dispose ran past its deadline; teardown went on without it. */
  disposeTimedOut?(index: number): void;
}) {
  const startup = new AbortController();
  let settleInitialization: () => void = () => {};
  const initialized = new Promise<void>((resolve) => {
    settleInitialization = resolve;
  });
  const resources: { dispose(): unknown; done: boolean }[] = [];
  let requested = false,
    complete = false,
    writerStopped = false,
    released = false;
  let prepared = false;
  let pending: Promise<void> | undefined;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let receiptPending: Promise<void> | undefined;
  let receiptReady: (() => void) | undefined;
  const markStop = (failure?: unknown) => {
    if (requested) return;
    requested = true;
    startup.abort();
    options.requested(failure);
  };
  const stop = () => {
    markStop();
    if (complete) return Promise.resolve();
    // OS quit supersedes an outstanding RPC receipt delay; it cannot skip initialization.
    clearTimeout(receiptTimer);
    receiptTimer = undefined;
    receiptReady?.();
    receiptReady = undefined;
    if (pending) return pending;
    const attempt = (async () => {
      await initialized;
      if (!prepared) {
        await options.prepareStop();
        prepared = true;
      }
      if (!writerStopped) {
        await options.stopWriter();
        writerStopped = true;
      }
      // Mac acceptance 2026-11-20: after the Bot browser had been used, one dispose never
      // returned and quitting hung until the process was killed. Each gets a deadline.
      const ordered = [...resources].reverse();
      for (const [index, resource] of ordered.entries()) {
        if (!resource.done) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = await Promise.race([
            Promise.resolve(resource.dispose()).then(() => false),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(true), DISPOSE_DEADLINE_MS);
            }),
          ]).finally(() => clearTimeout(timer));
          if (late) options.disposeTimedOut?.(ordered.length - 1 - index);
          resource.done = true;
        }
      }
      if (!released) {
        await options.release();
        released = true;
      }
      await options.finish();
      complete = true;
    })();
    pending = attempt;
    void attempt.then(
      () => {
        if (pending === attempt) pending = undefined;
      },
      () => {
        if (pending === attempt) pending = undefined;
        options.failed();
      },
    );
    return attempt;
  };
  return {
    get requested() {
      return requested;
    },
    get complete() {
      return complete;
    },
    signal: startup.signal,
    active() {
      startup.signal.throwIfAborted();
    },
    own(dispose: () => unknown) {
      resources.push({ dispose, done: false });
    },
    stop,
    requestStop() {
      // Mark before returning the authenticated acknowledgement. Even a sub-25ms init
      // completion must not construct/bootstrap a writer after this receipt.
      markStop();
      if (pending || receiptTimer || complete) return;
      const receipt = new Promise<void>((resolve) => {
        receiptReady = resolve;
        receiptTimer = setTimeout(() => {
          receiptTimer = undefined;
          receiptReady = undefined;
          resolve();
        }, 25);
      });
      receiptPending = receipt;
      void receipt
        .then(() => stop())
        .catch(() => {
          /* The stop attempt logs failure and retains the unconfirmed writer claim. */
        });
    },
    async initialize(action: () => Promise<void>) {
      let failure: unknown;
      let failed = false;
      try {
        await action();
      } catch (error) {
        failed = true;
        failure = error;
        // The stop below quits the app before the caller can log the rethrown error, so the
        // reason has to travel with the stop request (a long data folder only logged startup_failed).
        markStop(error);
      } finally {
        settleInitialization();
      }
      if (requested) {
        await receiptPending;
        await stop();
      }
      // A deliberate startup cancellation is a completed stop, not a new startup failure.
      if (failed && failure !== startup.signal.reason) throw failure;
    },
  };
}
