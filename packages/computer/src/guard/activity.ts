/**
 * User activity from the HID idle clock. The driver's own clicks and keys also reset that
 * clock. Only the requesting run's actual foreground HID dispatch may explain a reset; a
 * background call or another run's injection must never hide the user's activity. Attribution
 * cannot distinguish real user input during that same native injection, so its window is kept
 * as narrow as the native operation and a short delivery grace period.
 */
export function createActivityTracker(options: { now?: () => number; graceMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? 300;
  const runs = new Map<
    string,
    { injections: { start: number; end: number }[]; lastUser?: number }
  >();
  const state = (runId: string) => {
    let found = runs.get(runId);
    if (!found) {
      found = { injections: [] };
      runs.set(runId, found);
    }
    return found;
  };

  return {
    /** Wraps a step that injects input so its resets of the idle clock are attributed to us. */
    async injecting<T>(runId: string, run: () => Promise<T>): Promise<T> {
      const { injections } = state(runId);
      const entry = { start: now(), end: Number.POSITIVE_INFINITY };
      injections.push(entry);
      try {
        return await run();
      } finally {
        entry.end = now();
      }
    },
    /** Seconds since the user's last input, given the clock's current reading. */
    observe(runId: string, hidIdleSeconds: number): number {
      const current = state(runId);
      const { injections } = current;
      const t = now();
      const resetAt = t - hidIdleSeconds * 1000;
      const ours = injections.some((i) => resetAt >= i.start && resetAt <= i.end + graceMs);
      if (!ours && (current.lastUser === undefined || resetAt > current.lastUser + 20))
        current.lastUser = resetAt;
      // Old injections can no longer explain a reset older than the newest reading.
      while (injections.length && injections[0] && injections[0].end + graceMs < t - 60_000)
        injections.shift();
      return current.lastUser === undefined
        ? hidIdleSeconds
        : Math.max(0, (t - current.lastUser) / 1000);
    },
    release: (runId: string) => runs.delete(runId),
    clear: () => runs.clear(),
  };
}
