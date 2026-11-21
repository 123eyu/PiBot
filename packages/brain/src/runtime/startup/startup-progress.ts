/**
 * Liveness for the owner's startup watchdog. The watchdog used to see host RPC alone, so
 * a startup phase that calls no host method (session-tail recovery can take tens of seconds on a
 * real data directory) looked dead and the child was killed mid-startup, over and over.
 *
 * A plain beat every second would break the watchdog the other way round: a hung `await` keeps the
 * event loop alive, so the child would renew its own window forever and the 15 second deadline
 * would only be bounded by the outer hard cap. Beats are therefore sent only when startup work has
 * actually finished since the previous beat.
 */
export interface StartupProgress {
  /** One unit of startup work finished in `phase`; the next beat names it. */
  advance(phase: string): void;
  stop(): void;
}

export function createStartupProgress(
  send: (completedPhase: string) => void,
  intervalMs = 1_000,
): StartupProgress {
  // Counters rather than a dirty flag: beats may be slower than advances (a page per millisecond),
  // and every beat still names the phase the latest advance came from.
  let advanced = 0;
  let sent = 0;
  let phase = "";
  const timer = setInterval(() => {
    if (advanced === sent) return;
    sent = advanced;
    send(phase);
  }, intervalMs);
  timer.unref?.();
  return {
    advance(name) {
      phase = name;
      advanced += 1;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
