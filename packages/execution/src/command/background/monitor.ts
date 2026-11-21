import { isLoopbackAddress, type ListenerScan, listeningSockets } from "../../listeners/index.ts";
import { createNamespaceForwarder, namespacedListeners } from "../../listeners/linux-forward.ts";
import { type ProcessRow, snapshot } from "../process-tree.ts";
import type { BackgroundDependencies, Job } from "./types.ts";

const FAST_MS = 250;
const SLOW_MS = 2000;
const FAST_WINDOW_MS = 5000;

/** One snapshot and listener scan for all jobs; failures never erase known membership. */
export function createBackgroundMonitor(
  deps: BackgroundDependencies,
  jobs: Map<string, Job>,
  lifetime: AbortController,
) {
  const { platform } = deps;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking: Promise<void> | undefined;
  let scanFailures = 0;
  const progress = new Map<string, number>();
  function monitorFailed(running: Job[]) {
    if (lifetime.signal.aborted || ++scanFailures < 3) return;
    for (const job of running) {
      if (!job.running) continue;
      if (!job.listeners.supported && job.listeners.reason === "network_namespace") continue;
      job.listenerFailure();
      void job.stopFor("failed").catch(() => {
        // stopFor seals admission and retains ownership when the real tree cannot be drained.
      });
    }
  }

  /** Ports reachable on this host, or undefined when forwarding is unavailable here. */
  async function forward(job: Job, pid: number, signal: AbortSignal) {
    if (platform !== "linux") return undefined;
    const sockets = await namespacedListeners(
      [pid, ...job.members.map((row) => row.pid).filter((member) => member !== pid)],
      signal,
    );
    job.forwarder ??= createNamespaceForwarder();
    const ports = await job.forwarder.sync(pid, sockets);
    // Listeners exist but none could be relayed (tools missing, host port taken): stay explicit.
    return sockets.length && !ports.length ? undefined : ports;
  }

  function schedule(delay?: number) {
    if (lifetime.signal.aborted || timer || !jobs.size) return;
    const young = [...jobs.values()].some((job) => Date.now() - job.startedAt < FAST_WINDOW_MS);
    timer = setTimeout(
      () => {
        timer = undefined;
        ticking ??= tick().finally(() => {
          ticking = undefined;
          schedule();
        });
      },
      delay ?? (young ? FAST_MS : SLOW_MS),
    );
    timer.unref?.();
  }

  async function tick() {
    const running = [...jobs.values()].filter((job) => job.running);
    for (const id of progress.keys()) if (!jobs.has(id)) progress.delete(id);
    // Reuse the monitor cadence: output never starts a timer, filesystem write or listener scan.
    for (const job of running) {
      if (job.outputLines === undefined || progress.get(job.id) === job.outputLines) continue;
      progress.set(job.id, job.outputLines);
      try {
        job.callbacks.onProgress?.(job);
      } catch {
        // A failed progress view must not interrupt the security monitor or process cleanup.
      }
    }
    if (!running.length) return;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]);
    let rows: ProcessRow[];
    try {
      rows = await snapshot(deps.env(), platform);
    } catch {
      monitorFailed(running);
      return;
    }
    const changed = new Set<Job>();
    for (const job of running) if (job.update(job.tree.update(rows))) changed.add(job);
    const live = running.filter((job) => job.members.length);
    let scan: ListenerScan | undefined;
    try {
      scan = await listeningSockets(
        live.flatMap((job) => job.members.map((row) => row.pid)),
        platform,
        deps.env(),
        signal,
      );
    } catch {
      monitorFailed(running);
    }
    if (scan?.supported) scanFailures = 0;
    else if (scan) monitorFailed(running);
    for (const job of running) {
      if (scan) {
        const pids = new Set(job.members.map((row) => row.pid));
        // Linux: a tree with any process in another network namespace is a bubblewrap-isolated
        // command; its ports exist only inside the sandbox.
        const isolatedPid = scan.supported
          ? scan.namespaced?.find((pid) => pids.has(pid))
          : undefined;
        // F-L1: an isolated command's loopback ports are forwarded to the same host port.
        const forwarded =
          isolatedPid !== undefined
            ? await forward(job, isolatedPid, signal).catch(() => undefined)
            : undefined;
        const own: ListenerScan = !scan.supported
          ? scan
          : isolatedPid !== undefined
            ? forwarded
              ? {
                  supported: true,
                  sockets: forwarded.map((port) => ({
                    pid: isolatedPid,
                    address: "127.0.0.1",
                    port,
                  })),
                }
              : { supported: false, reason: "network_namespace" }
            : {
                supported: true,
                // A sandbox host's own SRT proxy listens too; that is not a service of the Bot.
                sockets: scan.sockets.filter(
                  (socket) => pids.has(socket.pid) && !(job.hosted && socket.pid === job.root),
                ),
              };
        if (job.setListeners(own)) changed.add(job);
        if (own.supported && own.sockets.some((socket) => !isLoopbackAddress(socket.address)))
          void job.stopFor("exposed").catch(() => {
            // stopFor retains the live job and seals admission; dispose reports the failure.
          });
      }
      if (job.rootExited && !job.members.length) void job.finish("exited");
    }
    for (const job of changed) if (job.running) job.callbacks.onChange?.(job);
  }

  return {
    schedule,
    reschedule() {
      clearTimeout(timer);
      timer = undefined;
      schedule(50);
    },
    removed() {
      if (!jobs.size) {
        scanFailures = 0;
        progress.clear();
      }
    },
    async dispose() {
      clearTimeout(timer);
      timer = undefined;
      await ticking;
      progress.clear();
    },
  };
}
