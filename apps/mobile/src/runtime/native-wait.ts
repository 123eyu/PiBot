/** Native dialogs/token requests may finish after navigation; late values must never dispatch RPCs. */
export function nativeWait<T>(
  operation: Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("native_cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) reject(new Error("native_unavailable"));
      },
    );
    if (signal.aborted) abort();
  });
}
