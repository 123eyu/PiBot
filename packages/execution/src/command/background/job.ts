import { type ChildProcess, spawn } from "node:child_process";
import { ExecError } from "../../core/types.ts";
import { isLoopbackAddress, type ListenerScan } from "../../listeners/index.ts";
import { createTreeState } from "../process-tree.ts";
import { RollingLog } from "../rolling-log.ts";
import { hostReady } from "./host-ready.ts";
import { createBackgroundInput } from "./input.ts";
import { createBackgroundOutput } from "./output.ts";
import type {
  BackgroundDependencies,
  BackgroundEndReason,
  BackgroundJob,
  Job,
  Spec,
} from "./types.ts";

const key = (rows: { pid: number; started: string }[]) =>
  rows
    .map((row) => `${row.pid}:${row.started}`)
    .sort()
    .join(",");

interface JobDependencies extends BackgroundDependencies {
  lifetime: AbortController;
  assertHealthy(): void;
  failDrain(error: ExecError, jobId?: string): void;
  terminate(job: Job): Promise<void>;
  removed(job: Job): void;
  added(job: Job): void;
  rootExited(): void;
}
/** Owns one process, its redacted output and its terminal resource release. */
export function createBackgroundStarter(deps: JobDependencies) {
  const { platform, lifetime } = deps;
  return async (spec: Spec): Promise<BackgroundJob> => {
    deps.assertHealthy();
    if (lifetime.signal.aborted) throw new ExecError("closed");
    let child: ChildProcess | undefined;
    let paused = false;
    const resume = () => {
      if (!paused) return;
      paused = false;
      child?.stdout?.resume();
      child?.stderr?.resume();
    };
    const log = await RollingLog.create(spec.logPath, resume, resume);
    const segment = {
      toolCallId:
        spec.toolCallId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(spec.toolCallId)
          ? spec.toolCallId
          : "unavailable",
      startedAt: new Date().toISOString(),
    };
    log.write(`\n[PiBot command start] ${JSON.stringify(segment)}\n`);
    try {
      deps.assertHealthy();
      lifetime.signal.throwIfAborted();
      spec.host?.signal.throwIfAborted();
      await spec.beforeSpawn?.();
      lifetime.signal.throwIfAborted();
      child = spawn(spec.shell, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: platform !== "win32",
        windowsHide: true,
        // fd 0 remains the host's liveness/control channel; fd 4 carries command input.
        stdio: spec.host ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      await log.close();
      throw error;
    }
    const pid = child.pid;
    if (!pid) {
      child.unref();
      await log.close();
      await spec.host?.cleanup();
      throw new Error("spawn_failed");
    }
    const spawned = child;
    const input = createBackgroundInput({
      stream: (spec.host ? spawned.stdio[4] : spawned.stdin) as
        | import("node:stream").Writable
        | undefined,
      running: () => running && !requested && !job.rootExited,
      stop: () => job.stopFor("stopped"),
    });
    let exitCode: number | null = null;
    let running = true;
    let listeners: ListenerScan = { supported: true, sockets: [] };
    // Keep discovery order in the owning job so a newly mounted renderer does not fall back to
    // the OS/socket scan's numeric order. A port that disappears is removed and gets a new rank
    // if the process starts listening on it again.
    let portSequence = 0;
    const portOrder = new Map<number, number>();
    let membersKey = "";
    let listenersKey = "";
    let stopping: Promise<void> | undefined;
    // A stop wins over the exit the monitor may observe while the tree is being terminated.
    let requested: BackgroundEndReason | undefined;
    let errorCode: "listener_check_failed" | undefined;
    let finishing: Promise<void> | undefined;
    let resolveEnded!: (value: {
      exitCode: number | null;
      reason: BackgroundEndReason;
      errorCode?: "listener_check_failed";
    }) => void;
    const ended = new Promise<{
      exitCode: number | null;
      reason: BackgroundEndReason;
      errorCode?: "listener_check_failed";
    }>((resolve) => {
      resolveEnded = resolve;
    });
    const output = createBackgroundOutput(spawned.stdout, spawned.stderr, deps.redactor, (text) => {
      if (!log.write(text) && !paused) {
        paused = true;
        spawned.stdout?.pause();
        spawned.stderr?.pause();
      }
    });
    const job: Job = {
      id: spec.id,
      logPath: spec.logPath,
      root: pid,
      hosted: Boolean(spec.host),
      tree: createTreeState(pid, platform),
      members: [],
      startedAt: Date.now(),
      rootExited: false,
      callbacks: spec.callbacks,
      get running() {
        return running;
      },
      get outputLines() {
        return output.lines;
      },
      get permissionOnly() {
        return output.permissionOnly;
      },
      get listeners() {
        return listeners;
      },
      ended,
      ports() {
        if (!listeners.supported) return [];
        const current = listeners.sockets
          .filter((socket) => isLoopbackAddress(socket.address))
          .map((socket) => socket.port);
        return [...new Set(current)].sort(
          (a, b) => (portOrder.get(b) ?? -1) - (portOrder.get(a) ?? -1) || a - b,
        );
      },
      output(maxChars) {
        return output.text(maxChars);
      },
      record() {
        return {
          group: pid,
          processes: job.members.map((row) => ({ pid: row.pid, started: row.started })),
        };
      },
      writeInput: input.write,
      update(members) {
        job.members = members;
        const next = key(members);
        if (next === membersKey) return false;
        membersKey = next;
        return true;
      },
      setListeners(scan) {
        const next = JSON.stringify(scan);
        // Rank the ports where the scan arrives (not in `ports()`): a newly mounted renderer reads
        // the list in discovery order, and a port that disappears loses its rank so it gets a new
        // one if the process listens on it again.
        const current = scan.supported
          ? new Set(
              scan.sockets
                .filter((socket) => isLoopbackAddress(socket.address))
                .map((socket) => socket.port),
            )
          : new Set<number>();
        for (const port of portOrder.keys()) if (!current.has(port)) portOrder.delete(port);
        for (const port of current) portOrder.set(port, portOrder.get(port) ?? portSequence++);
        listeners = scan;
        if (next === listenersKey) return false;
        listenersKey = next;
        return true;
      },
      stop() {
        return job.stopFor("stopped");
      },
      listenerFailure() {
        if (errorCode) return;
        errorCode = "listener_check_failed";
        output.appendDiagnostic(
          "\nlistener_check_failed: listener inspection failed 3 times; stopping / 监听检查连续失败3次，正在停止\n",
        );
        try {
          deps.onMonitorFailure?.(job.id);
        } catch {
          // A diagnostic sink must not prevent stopping an uninspectable service.
        }
      },
      stopFor(reason) {
        if (!running) return finishing ?? Promise.resolve();
        requested ??= reason;
        stopping ??= deps
          .terminate(job)
          .then(() => job.finish(reason))
          .catch((error: unknown) => {
            // The reason code tells an unconfirmed tree from a failed snapshot; both pause.
            deps.failDrain(
              error instanceof ExecError
                ? error
                : new ExecError("command_failed", "cleanup_failed"),
              job.id,
            );
            throw error;
          });
        return stopping;
      },
      finish(reason) {
        finishing ??= (async () => {
          running = false;
          deps.removed(job);
          output.finish(exitCode === 1 && reason === "exited" && !requested);
          spawned.stdout?.destroy();
          spawned.stderr?.destroy();
          spawned.stdin?.destroy();
          input.dispose();
          spawned.stdio[3]?.destroy();
          spawned.unref();
          log.write(
            `\n[PiBot command end] ${JSON.stringify({ ...segment, exitCode, reason: requested ?? reason })}\n`,
          );
          await log.close();
          // The relay keeps the sandbox's network namespace alive; it ends with the job.
          await job.forwarder?.dispose();
          try {
            await spec.host?.cleanup();
          } catch {
            // Only SRT's socket directory is left behind; a failure must not hide the job's end.
          }
          resolveEnded({
            exitCode,
            reason: requested ?? reason,
            ...(errorCode ? { errorCode } : {}),
          });
        })();
        return finishing;
      },
    };
    spawned.once("exit", (code) => {
      exitCode = code;
      job.rootExited = true;
      // Re-check soon: without children left the job has ended.
      deps.rootExited();
    });
    spawned.once("error", () => {
      job.rootExited = true;
      void job.finish("failed");
    });
    deps.added(job);
    if (
      spec.host &&
      !(await hostReady(lifetime, spawned, spec.host, () => job.stopFor("failed")))
    ) {
      await job.stopFor("failed");
      throw new ExecError("isolation_unavailable");
    }
    return job;
  };
}
