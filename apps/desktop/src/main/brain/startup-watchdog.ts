// OS authorization dialogs can block host handlers. Count only time outside host RPC work,
// granting a fresh startup interval after each completed batch of host requests or each startup
// progress report from the child: a slow session-tail recovery calls no host method, yet
// it is the child still working, not a hung process.
export interface StartupWatchdogTimeout {
  /**
   * The phase whose last unit of work the child reported before going quiet, so a timeout is
   * diagnosable from the log alone. It is the phase the child got *past*, not the one it is stuck
   * in: the report comes when work finishes, which is also why a hung await stops renewing.
   */
  afterPhase: string;
  /** The idle window that just expired: time since the last host RPC batch or progress report. */
  idleMs: number;
}

/**
 * 2026-11-06: under heavy CPU load (load average > 100 on 16 cores) a starting brain spent more
 * than 15 s between two progress reports, was killed, and the restart failed the same way; the
 * owner's app did not come up. A hung await burns no CPU, a starved-but-working child does, and
 * the parent can read the child's CPU time without the child's event loop. So an expired window
 * whose child used at least `minCpuSeconds` of CPU in it is renewed instead of fired, at most
 * `maxExtensions` times; the outer launch ceiling still bounds the whole start.
 */
export interface StartupCpuProbe {
  /** Cumulative CPU seconds of the child, or undefined when it cannot be read. */
  cpuSeconds(): number | undefined;
  /** A window is renewed only when the child used at least this much CPU in it. */
  minCpuSeconds: number;
  maxExtensions: number;
  /** Logged once per renewal so slow starts stay visible. */
  extended(info: StartupWatchdogTimeout & { cpuSeconds: number; extension: number }): void;
}

export function createStartupWatchdog(
  timeoutMs: number,
  onTimeout: (info: StartupWatchdogTimeout) => void,
  cpu?: StartupCpuProbe,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let afterPhase = "spawn";
  let lastSeen = performance.now();
  let extensions = 0;
  let cpuAtArm = cpu?.cpuSeconds();
  const arm = () => {
    cpuAtArm = cpu?.cpuSeconds();
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      const idleMs = Math.round(performance.now() - lastSeen);
      const now = cpu?.cpuSeconds();
      // No baseline means the child had no pid yet when the window opened: all of its CPU so far
      // was spent inside this window.
      const used = now === undefined ? 0 : now - (cpuAtArm ?? 0);
      if (cpu && used >= cpu.minCpuSeconds && extensions < cpu.maxExtensions) {
        extensions++;
        cpu.extended({ afterPhase, idleMs, cpuSeconds: used, extension: extensions });
        arm();
        return;
      }
      stopped = true;
      onTimeout({ afterPhase, idleMs });
    }, timeoutMs);
  };
  const restarted = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!stopped) arm();
  };
  arm();
  return {
    setBusy(busy: boolean) {
      if (busy) {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      lastSeen = performance.now();
      restarted();
    },
    progress(name: string) {
      if (stopped) return;
      afterPhase = name;
      lastSeen = performance.now();
      restarted();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
