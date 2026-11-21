import { type ChildProcess, spawn } from "node:child_process";
import { win32 } from "node:path";

/**
 * 2026-11-11 (Windows VM acceptance): every background security check started its own
 * powershell.exe. A cold PowerShell start costs 2–7 s on an idle 4-core VM and 10–20 s while the
 * machine is busy (just after sign-in), and one owner start needs four to six of them in series
 * (directory, lock, descriptor, brain PID publication), so the start took 30–50 s or never
 * finished. One resident PowerShell per process pays the start once, in parallel with the rest
 * of startup; each later check is a few milliseconds.
 *
 * Requests are fixed scripts built by this process (inputs travel as base64 data inside them),
 * sent over the child's private stdin pipe — the same trust boundary as `-EncodedCommand`. Each
 * runs in its own script-block scope, so no variable or function survives between requests.
 */
const LOOP = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "$stdin = [Console]::In",
  '[Console]::Out.Write("ready`n"); [Console]::Out.Flush()',
  "while ($true) {",
  "  $line = $stdin.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  $out = ''",
  "  try {",
  "    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))",
  "    $result = @(& ([ScriptBlock]::Create($text)))",
  "    if ($result.Count) { $out = [string]$result[-1] }",
  "  } catch { $out = '' }",
  // One response line per request; a script's result is compressed JSON (no newlines).
  '  [Console]::Out.Write($out.Replace("`n", \' \') + "`n"); [Console]::Out.Flush()',
  "}",
].join("\n");

/**
 * How long a cold PowerShell may take to become ready. Not a request timeout. At 100 % CPU the
 * acceptance VM took over 55 s just to start PowerShell, so 60 s failed the owner's first start
 * (startup_failed / background_descriptor_permissions). A slow start is not a refusal: wait it
 * out up to this bound; only a PowerShell that never answers is killed.
 */
export const POWERSHELL_START_TIMEOUT_MS = 150_000;
/** A warm worker is kept this long after its last request, then exits (respawned on demand). */
const IDLE_EXIT_MS = 60_000;
const MAX_LINE = 4096;

export class PowerShellWorkerError extends Error {
  constructor(readonly reason: "timeout" | "aborted" | "spawn" | "exited" | "max_buffer") {
    super(`powershell_worker_${reason}`);
  }
}

interface Pending {
  script: string;
  signal: AbortSignal;
  resolve(value: string): void;
  reject(error: Error): void;
}

export function createPowerShellWorker(options: { systemRoot: string | undefined }) {
  let child: ChildProcess | undefined;
  let ready = false;
  let buffer = "";
  let current: (Pending & { done(): void }) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let readyWaiters: { resolve(): void; reject(error: Error): void }[] = [];
  const queue: Pending[] = [];
  const settleReady = (error?: PowerShellWorkerError) => {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve();
  };

  const stopChild = (reason: PowerShellWorkerError["reason"]) => {
    const old = child;
    child = undefined;
    ready = false;
    buffer = "";
    clearTimeout(startTimer);
    clearTimeout(idleTimer);
    if (old && old.exitCode === null) old.kill();
    settleReady(new PowerShellWorkerError(reason));
    // A request already written may have been half-applied; its caller must re-check, not retry
    // blindly, which is what every caller of the security checks already does on a failure.
    const running = current;
    current = undefined;
    running?.reject(new PowerShellWorkerError(reason));
  };

  const start = () => {
    const root = options.systemRoot;
    if (!root || !win32.isAbsolute(root)) throw new PowerShellWorkerError("spawn");
    const spawned = spawn(
      win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(LOOP, "utf16le").toString("base64"),
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    child = spawned;
    spawned.stdout?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => {
      if (child !== spawned) return;
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        if (!ready) {
          if (line !== "ready") continue;
          ready = true;
          clearTimeout(startTimer);
          settleReady();
        } else {
          const done = current;
          current = undefined;
          done?.done();
          done?.resolve(line);
        }
        pump();
      }
      if (buffer.length > MAX_LINE) stopChild("max_buffer");
    });
    spawned.on("error", () => {
      if (child === spawned) stopChild("spawn");
      failQueued("spawn");
    });
    spawned.on("exit", () => {
      if (child === spawned) stopChild("exited");
    });
    // stdin errors (EPIPE after the child died) are reported through "exit".
    spawned.stdin?.on("error", () => {});
    startTimer = setTimeout(() => {
      if (child !== spawned || ready) return;
      stopChild("timeout");
      failQueued("timeout");
    }, POWERSHELL_START_TIMEOUT_MS);
    startTimer.unref?.();
  };

  const failQueued = (reason: PowerShellWorkerError["reason"]) => {
    for (const item of queue.splice(0)) item.reject(new PowerShellWorkerError(reason));
  };

  const pump = () => {
    if (current) return;
    // Aborted requests that never reached the worker are simply dropped: nothing ran.
    while (queue.length && queue[0]?.signal.aborted) {
      const dropped = queue.shift() as Pending;
      dropped.reject(new PowerShellWorkerError(abortReason(dropped.signal)));
    }
    const next = queue.shift();
    if (!next) {
      clearTimeout(idleTimer);
      if (child) {
        const idle = child;
        idleTimer = setTimeout(() => {
          if (child === idle && !current && !queue.length) {
            child = undefined;
            ready = false;
            idle.stdin?.end();
          }
        }, IDLE_EXIT_MS);
        idleTimer.unref?.();
      }
      return;
    }
    clearTimeout(idleTimer);
    if (!child) {
      queue.unshift(next);
      try {
        start();
      } catch (error) {
        failQueued(error instanceof PowerShellWorkerError ? error.reason : "spawn");
      }
      return;
    }
    if (!ready) {
      // Nothing is written before the worker is ready, so a request that times out while
      // PowerShell is still starting has not run and cannot run later.
      queue.unshift(next);
      return;
    }
    const onAbort = () => {
      if (current?.signal === next.signal) stopChild(abortReason(next.signal));
      pump();
    };
    next.signal.addEventListener("abort", onAbort, { once: true });
    current = { ...next, done: () => next.signal.removeEventListener("abort", onAbort) };
    child.stdin?.write(`${Buffer.from(next.script, "utf8").toString("base64")}\n`);
  };

  return {
    /** Starts PowerShell now so its cold start overlaps the caller's other startup work. */
    warm() {
      if (child) return;
      try {
        start();
      } catch {
        // Reported by the first real request.
      }
    },
    /**
     * Resolves once PowerShell is ready (starting it if needed), so a caller's per-request
     * timeout measures the script, not a cold start bounded by `POWERSHELL_START_TIMEOUT_MS`.
     */
    whenReady(signal: AbortSignal) {
      if (ready && child) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          readyWaiters = readyWaiters.filter((waiter) => waiter !== entry);
          reject(new PowerShellWorkerError(abortReason(signal)));
        };
        const entry = {
          resolve: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          reject: (error: Error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        };
        if (signal.aborted) return onAbort();
        readyWaiters.push(entry);
        signal.addEventListener("abort", onAbort, { once: true });
        if (!child)
          try {
            start();
          } catch (error) {
            settleReady(
              error instanceof PowerShellWorkerError ? error : new PowerShellWorkerError("spawn"),
            );
          }
      });
    },
    /** Runs one fixed script; resolves with its last output line (bounded by `MAX_LINE`). */
    run(script: string, signal: AbortSignal) {
      return new Promise<string>((resolve, reject) => {
        if (signal.aborted) {
          reject(new PowerShellWorkerError(abortReason(signal)));
          return;
        }
        const item: Pending = { script, signal, resolve, reject };
        queue.push(item);
        signal.addEventListener(
          "abort",
          () => {
            const index = queue.indexOf(item);
            if (index < 0) return;
            queue.splice(index, 1);
            reject(new PowerShellWorkerError(abortReason(signal)));
          },
          { once: true },
        );
        pump();
      });
    },
    dispose() {
      failQueued("aborted");
      stopChild("aborted");
    },
  };
}

export type PowerShellWorker = ReturnType<typeof createPowerShellWorker>;

function abortReason(signal: AbortSignal): "timeout" | "aborted" {
  return signal.reason instanceof Error && signal.reason.name === "TimeoutError"
    ? "timeout"
    : "aborted";
}
