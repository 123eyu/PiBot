/** Pass signal to Peer.call too to remove queued work; accepted mutations may still finish. */
export async function waitRpc<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
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
