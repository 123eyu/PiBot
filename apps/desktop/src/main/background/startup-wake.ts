/** A notification is only a hint to re-read authenticated state, never authority to attach. */
export function createStartupWake() {
  let notified = false;
  let waiting: (() => void) | undefined;
  return {
    notify() {
      notified = true;
      waiting?.();
    },
    wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (notified) {
        notified = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          waiting = undefined;
          notified = false;
          if (error) reject(error);
          else resolve();
        };
        const abort = () => {
          finish(new Error("background_wait_cancelled"));
        };
        const timer = setTimeout(finish, milliseconds);
        waiting = finish;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
  };
}
