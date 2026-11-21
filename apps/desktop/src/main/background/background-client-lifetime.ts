// Transport loss is not GUI exit; accepted quit intent must survive transport loss.
const RECONNECT_GRACE_MS = 20_000;
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the process is gone; EPERM means it exists under another user.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function createBackgroundClientLifetime(options: {
  effectiveStop(): boolean;
  drain(): Promise<unknown>;
  stop(): Promise<void>;
  failed(): void;
  /** Tests shorten it; production waits RECONNECT_GRACE_MS. */
  reconnectGraceMs?: number;
}) {
  const clients = new Set<string>();
  const watchers = new Map<number, ReturnType<typeof setTimeout>>();
  const graceWaiters = new Set<() => void>();
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const requestStop = (delay = 25) => {
    if (disposed) return;
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = undefined;
      if (!disposed) void options.stop().catch(options.failed);
    }, delay);
  };
  const watch = (pid: number) => {
    clearTimeout(watchers.get(pid));
    watchers.delete(pid);
    if (disposed || clients.size) return;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        requestStop();
        return;
      }
      options.failed(); // EPERM and unknown errors never prove process death.
    }
    const timer = setTimeout(() => watch(pid), 1000);
    timer.unref();
    watchers.set(pid, timer);
  };
  return {
    get size() {
      return clients.size;
    },
    attach(id: string) {
      clients.add(id);
      for (const wake of [...graceWaiters]) wake();
      for (const timer of watchers.values()) clearTimeout(timer);
      watchers.clear();
    },
    async detach(id: string, stop: boolean) {
      clients.delete(id);
      if (stop || (!clients.size && options.effectiveStop())) {
        // Full stop drains all runs and closes admission. A preliminary interactive drain
        // would delay the stop receipt and leave a restart waiting through two drain budgets.
        requestStop();
      } else if (!clients.size) await options.drain();
    },
    async disconnected(id: string, pid: number) {
      const wasAttached = clients.delete(id);
      if (disposed || clients.size) return;
      if (options.effectiveStop()) watch(pid);
      if (!wasAttached) return;
      // A lost transport is not the GUI leaving: a stalled main thread dropped the socket while
      // the window stayed open and reconnected seconds later, but draining at once had already
      // cancelled every running Bot turn (maintainers 2026-11-18, 小媒 on x.com). Wait a bounded grace
      // for a reconnect; an explicit detach (window closed, quit) still drains immediately.
      // A GUI that is really gone (killed, crashed) skips the grace: polled, so its exit counts.
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          clearInterval(poll);
          graceWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, options.reconnectGraceMs ?? RECONNECT_GRACE_MS);
        const poll = setInterval(() => {
          if (!processAlive(pid)) wake();
        }, 250);
        timer.unref();
        poll.unref();
        graceWaiters.add(wake);
        if (!processAlive(pid)) wake();
      });
      if (disposed || clients.size) return;
      await options.drain();
    },
    requestStop,
    dispose() {
      disposed = true;
      for (const wake of [...graceWaiters]) wake();
      clearTimeout(stopTimer);
      for (const timer of watchers.values()) clearTimeout(timer);
      watchers.clear();
      clients.clear();
    },
  };
}
