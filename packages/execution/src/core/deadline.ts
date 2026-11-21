import { ExecError } from "./types.ts";

/** The caller settles even when the underlying dependency ignores cancellation. */
export function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  error: ExecError,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new ExecError(error.code, "cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(error);
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (failure: unknown) => {
        cleanup();
        reject(failure);
      },
    );
    if (signal?.aborted) abort();
  });
}

/** A firing this late means the brain's own thread was stalled, not that the dependency was slow. */
const STALL_MS = 1_000;
/** Enough for one loop turn to read the I/O that completed during the stall. */
const STALL_GRACE_MS = 1_000;
/** A brain that keeps stalling still reaches the deadline. */
const STALL_DEFERRALS = 3;

/**
 * setTimeout for deadlines on child processes. After a main-thread stall Node runs due timers
 * before the I/O that completed meanwhile (measured: a child that exited during a 3 s stall still
 * had exitCode null when its 1 s timer fired), so a plain timer reported finished Windows process
 * snapshots as timed out and their commands' cleanup as unconfirmed. A late firing first gives
 * that I/O a short, bounded grace.
 */
export function stallTolerantTimeout(callback: () => void, milliseconds: number) {
  let deferrals = 0;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (delay: number) => {
    const due = performance.now() + delay;
    timer = setTimeout(() => {
      if (performance.now() - due >= STALL_MS && deferrals < STALL_DEFERRALS) {
        deferrals += 1;
        arm(STALL_GRACE_MS);
        return;
      }
      callback();
    }, delay);
  };
  arm(milliseconds);
  return { clear: () => clearTimeout(timer) };
}
