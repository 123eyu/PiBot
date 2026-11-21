/** SDK cancellation sends a notification but does not settle its request promise. Keep observing
 * the original response while ending the local wait at our own cancellation boundary. */
export function waitForResponse<T>(response: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    response.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}
