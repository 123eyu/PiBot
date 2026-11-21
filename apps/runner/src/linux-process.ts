import { spawn } from "node:child_process";
import { isSea } from "node:sea";
import { setTimeout as delay } from "node:timers/promises";
import { processAlive, readRunnerState } from "./state.ts";

/** SEA's executable owns its entry point; source/directory builds still need the script argument. */
export function runnerInvocation() {
  if (isSea()) return { executable: process.execPath, prefix: [] as string[] };
  const script = process.argv[1];
  if (!script) throw new Error("runner_entry_unavailable");
  return { executable: process.execPath, prefix: [...process.execArgv, script] };
}

export async function startLinuxDaemon(
  dataDir: string,
  args: readonly string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (process.platform !== "linux") throw new Error("unsupported_platform");
  const state = await readRunnerState(dataDir);
  if (state && processAlive(state.pid)) throw new Error("runner_already_running");
  const invocation = runnerInvocation();
  const child = spawn(invocation.executable, [...invocation.prefix, ...args], {
    detached: true,
    stdio: "ignore",
    shell: false,
    env: { ...process.env, PIBOT_DATA_DIR: dataDir },
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await spawned;
  child.unref();
  // A detached spawn is not a ready receipt: credentials can fail before the control port exists.
  try {
    while (true) {
      signal.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("runner_daemon_start_failed");
      const current = await readRunnerState(dataDir);
      if (current && current.pid === child.pid && current.status !== "drain_incomplete")
        return current.pid;
      await delay(100, undefined, { signal });
    }
  } catch (error) {
    // A timed-out launch still owns a real process. Request normal drain before reporting failure.
    child.kill("SIGTERM");
    const deadline = Date.now() + 30_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
      await delay(100);
    if (child.exitCode === null && child.signalCode === null)
      throw new Error("runner_daemon_drain_unconfirmed", { cause: { pid: child.pid } });
    throw error;
  }
}

/** A control acknowledgement only starts shutdown; callers must not mistake it for drain. */
export async function waitRunnerExit(
  owner: { pid: number; startedAt: string },
  signal: AbortSignal,
) {
  while (processAlive(owner.pid)) {
    signal.throwIfAborted();
    await delay(100, undefined, { signal });
  }
}
