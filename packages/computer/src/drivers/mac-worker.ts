import { type ChildProcess, spawn } from "node:child_process";
import { bounded, ComputerError, DEFAULT_CALL_TIMEOUT_MS } from "../core/errors.ts";
import type { InputInjection } from "../core/types.ts";
import { MAC_WORKER_SCRIPT } from "./mac-worker-script.ts";

type Reply = { id: number; ok: boolean; result?: unknown; error?: string };
interface Waiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface MacWorker {
  call<T>(
    op: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
    inject?: InputInjection,
  ): Promise<T>;
  /** Stops the helper process; the next call starts a fresh one. */
  release(): Promise<void>;
  drain?(): Promise<void>;
}

const OSASCRIPT = "/usr/bin/osascript";
const MAX_LINE = 1024 * 1024;

/**
 * Resident `osascript -l JavaScript` helper (spawning one per call costs 100–200 ms).
 * This is a fixed, Pi Bot-owned helper with a constant argv, not an agent command, so it is
 * spawned here rather than through packages/execution (rule 9 covers commands the model asks for).
 * Ownership: created lazily on the first call; stopped by release(), after `idleMs` without
 * calls, or when a call times out (a hung bridge call cannot be interrupted any other way).
 */
export function createMacWorker(
  options: { timeoutMs?: number; idleMs?: number; onExit?(code: number | null): void } = {},
): MacWorker {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const idleMs = options.idleMs ?? 120_000;
  let child: ChildProcess | undefined;
  let next = 1;
  let buffer = "";
  const waiting = new Map<number, Waiter>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;

  const failAll = (error: Error) => {
    for (const waiter of waiting.values()) waiter.reject(error);
    waiting.clear();
  };
  const stop = () => {
    if (stopping) return stopping;
    const current = child;
    child = undefined;
    buffer = "";
    clearTimeout(idleTimer);
    failAll(new ComputerError("cancelled", "worker_stopped"));
    if (!current || current.exitCode !== null || current.signalCode !== null)
      return Promise.resolve();
    const retired = new Promise<void>((resolve, reject) => {
      const kill = setTimeout(() => current.kill("SIGKILL"), 2000);
      const deadline = setTimeout(
        () => reject(new ComputerError("timeout", "worker_drain_unconfirmed")),
        5000,
      );
      current.once("exit", () => {
        clearTimeout(kill);
        clearTimeout(deadline);
        resolve();
      });
      current.stdin?.end();
      current.kill("SIGTERM");
    });
    stopping = retired;
    void retired.then(
      () => {
        if (stopping === retired) stopping = undefined;
      },
      () => {
        // Failed drain remains sticky: another helper cannot start while the old one may inject.
      },
    );
    return retired;
  };
  const onLine = (line: string) => {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      // osascript may print diagnostics to stdout; only JSON replies belong to the protocol.
      return;
    }
    const waiter = waiting.get(reply.id);
    if (!waiter) return;
    waiting.delete(reply.id);
    if (reply.ok) waiter.resolve(reply.result);
    else
      waiter.reject(
        new ComputerError("driver_error", `worker_${(reply.error ?? "").slice(0, 120)}`),
      );
  };
  const start = () => {
    const proc = spawn(OSASCRIPT, ["-l", "JavaScript", "-e", MAC_WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    // EPIPE after the helper died is reported through "exit", which fails the waiters.
    proc.stdin?.on("error", () => {});
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        void stop().catch(() => {
          /* release() retains and reports the failed drain. */
        });
        return;
      }
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        onLine(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
    });
    proc.once("exit", (code) => {
      if (child === proc) {
        child = undefined;
        failAll(new ComputerError("driver_error", "worker_exited"));
      }
      options.onExit?.(code);
    });
    proc.once("error", () => {
      if (child === proc) {
        child = undefined;
        failAll(new ComputerError("unsupported", "osascript_unavailable"));
      }
    });
    child = proc;
    return proc;
  };
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () =>
        void stop().catch(() => {
          /* Reported by release(). */
        }),
      idleMs,
    );
    idleTimer.unref?.();
  };
  return {
    async call<T>(
      op: string,
      args: Record<string, unknown> = {},
      signal?: AbortSignal,
      inject?: InputInjection,
    ) {
      await stopping;
      if (signal?.aborted) throw new ComputerError("cancelled", `worker.${op}`);
      const proc = child ?? start();
      touch();
      const id = next++;
      const send = async () => {
        try {
          return (await bounded(`worker.${op}`, timeoutMs, signal, () => {
            const reply = new Promise<unknown>((resolve, reject) =>
              waiting.set(id, { resolve, reject }),
            );
            proc.stdin?.write(`${JSON.stringify({ ...args, id, op })}\n`);
            return reply;
          })) as T;
        } catch (error) {
          waiting.delete(id);
          // The bridge call may still be running inside osascript; replace the process rather
          // than let the next request queue behind it.
          if (
            error instanceof ComputerError &&
            (error.code === "timeout" || error.code === "cancelled")
          ) {
            if (child === proc) await stop();
            else await stopping;
          }
          throw error;
        }
      };
      // Waiting for an older helper to stop is not an input injection window.
      return inject ? inject(send) : send();
    },
    release: stop,
    async drain() {
      await stopping;
    },
  };
}
