// The tray's last resort when Quit cannot reach its runner: the owner on ssh win (2026-11-15) had
// a runner that went silent after a WebRTC close, its control port gone for three days, so every
// Quit failed with "runner_stop_failed" and the tray could never close. A stop request that cannot
// be delivered ends the process instead, but only after its start time proves it is the runner
// the state file describes; a PID reused by another program is never touched.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { processAlive, type RunningState } from "../state.ts";

/** The runner writes its state right after start; its process began at most this much earlier. */
const START_TOLERANCE_MS = 120_000;
const EXIT_WAIT_MS = 10_000;

function output(command: string, args: readonly string[]) {
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
      signal: AbortSignal.timeout(10_000),
    });
    let text = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (text.length < 4096) text += chunk;
    });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? text.trim() : undefined));
  });
}

/** When the process with this PID started (ms since epoch), from the OS. */
async function processStartedAt(pid: number): Promise<number | undefined> {
  const text =
    process.platform === "win32"
      ? await output("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ])
      : await output("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
  const value = text ? Date.parse(text) : Number.NaN;
  return Number.isNaN(value) ? undefined : value;
}

/** The live process is the runner the state file was written for. */
export async function isStateRunner(state: RunningState) {
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0 || !processAlive(state.pid)) return false;
  const started = await processStartedAt(state.pid);
  const recorded = Date.parse(state.startedAt);
  if (started === undefined || Number.isNaN(recorded)) return false;
  // lstart has one-second resolution; the state is written after the process started.
  return started <= recorded + 1_000 && recorded - started <= START_TOLERANCE_MS;
}

/** Ends the runner and what it started; resolves once it is gone or the wait ran out. */
export async function endRunnerProcess(pid: number) {
  if (process.platform === "win32") {
    await output("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone between the check and here.
    }
    const soft = Date.now() + 5_000;
    while (processAlive(pid) && Date.now() < soft) await delay(100);
    if (processAlive(pid))
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
  }
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error("runner_stop_timeout");
    await delay(100);
  }
}
