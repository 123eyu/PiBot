import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { store } from "./context.ts";

export interface AsyncCommandResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  cancelled: boolean;
  timedOut: boolean;
  drained: boolean;
  pid?: number;
  log: string;
  durationMs: number;
  text(): string;
}

/** Developer commands, not agent commands. Only this invocation's private POSIX group is stopped. */
export async function runLoggedAsync(
  id: string,
  name: string,
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
): Promise<AsyncCommandResult> {
  options.signal.throwIfAborted();
  const started = Date.now();
  mkdirSync(join(store.dir, "logs"), { recursive: true });
  const log = join(store.dir, "logs", `${id}-${name}-${randomUUID()}.log`);
  const fd = openSync(log, "wx", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    options.signal.throwIfAborted();
    if (process.platform === "win32") throw new Error("workflow_host_unsupported");
    child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", fd, fd],
      detached: true,
    });
  } finally {
    closeSync(fd);
  }
  return new Promise((resolve) => {
    let done = false,
      cancelled = false,
      timedOut = false,
      errorCode: string | undefined;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") errorCode = "process_kill_failed";
      }
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null, drained: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearTimeout(killer);
      clearTimeout(hardStop);
      clearInterval(sizeCheck);
      options.signal.removeEventListener("abort", abort);
      child.unref();
      resolve({
        ok: code === 0 && !signal && !errorCode && !cancelled && !timedOut && drained,
        code,
        signal,
        errorCode,
        cancelled,
        timedOut,
        drained,
        pid: child.pid,
        log,
        durationMs: Date.now() - started,
        text: () => readFileSync(log, "utf8"),
      });
    };
    const stop = () => {
      if (done || hardStop) return;
      kill("SIGTERM");
      killer = setTimeout(() => kill("SIGKILL"), 2000);
      // An unkillable group is a durable unknown, never a reclaimed lease.
      hardStop = setTimeout(() => finish(null, null, false), 8000);
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const sizeCheck = setInterval(() => {
      try {
        if (statSync(log).size > 256 * 1024 * 1024) {
          errorCode = "output_limit";
          stop();
        }
      } catch {
        errorCode = "log_unavailable";
        stop();
      }
    }, 1000);
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => {
      errorCode = /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code ?? "") ? error.code : "spawn_failed";
    });
    child.once("close", async (code, signal) => {
      if (done) return;
      if (alive()) {
        if (!cancelled && !timedOut) errorCode = "process_group_leaked";
        stop();
        const deadline = Date.now() + 6000;
        while (!done && alive() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
      finish(code, signal, !alive());
    });
    if (options.signal.aborted) abort();
  });
}
