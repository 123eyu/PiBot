/** Cancelling ends the local wait; the existing read-only RPC has no remote cancellation. */
export async function auditRead<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      operation().then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
