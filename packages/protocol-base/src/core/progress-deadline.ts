/** Work owns both timers and disposes them on every outcome. Progress renews only idle time. */
export function progressDeadline(
  parent: AbortSignal,
  files = 20_000,
  bytes = 500 * 1024 * 1024,
  idleMs = 60_000,
) {
  const controller = new AbortController();
  const fail = () => controller.abort(new DOMException("Work timed out", "TimeoutError"));
  const totalMs = Math.min(
    2 * 60 * 60_000,
    15 * 60_000 + files * 200 + Math.ceil(bytes / (1024 * 1024)) * 2_000,
  );
  const total = setTimeout(fail, totalMs);
  let idle = setTimeout(fail, idleMs);
  const signal = AbortSignal.any([parent, controller.signal]);
  let disposed = false;
  return {
    signal,
    touch() {
      clearTimeout(idle);
      if (!disposed && !signal.aborted) idle = setTimeout(fail, idleMs);
    },
    dispose() {
      disposed = true;
      clearTimeout(total);
      clearTimeout(idle);
    },
  };
}

export async function withProgressDeadline<T>(
  parent: AbortSignal,
  action: (signal: AbortSignal, touch: () => void) => Promise<T>,
  files?: number,
  bytes?: number,
): Promise<T> {
  const work = progressDeadline(parent, files, bytes);
  try {
    return await action(work.signal, work.touch);
  } finally {
    work.dispose();
  }
}
