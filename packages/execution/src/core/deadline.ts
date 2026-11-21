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
