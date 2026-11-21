import { spawn } from "node:child_process";
import type { CommandOptions, CommandResult } from "./types.ts";

/** Only fixed workflow commands reach this adapter; stdout is bounded and never persisted raw. */
export async function command(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  if (options.signal.aborted)
    return { code: null, signal: null, stopped: "cancelled", drained: true, out: "" };
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "ignore"],
    detached: process.platform !== "win32",
  });
  let stopped: CommandResult["stopped"];
  let errorCode: string | undefined;
  let out = "";
  let finished = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const groupAlive = () => {
    if (!child.pid || process.platform === "win32") return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") errorCode = "process_kill_failed";
    }
  };
  return new Promise((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, drained: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(killer);
      clearTimeout(hardStop);
      options.signal.removeEventListener("abort", abort);
      child.stdout?.destroy();
      child.unref();
      resolve({ code, signal, errorCode, stopped, drained, out });
    };
    const stop = (reason: NonNullable<CommandResult["stopped"]>) => {
      if (stopped || finished) return;
      stopped = reason;
      kill("SIGTERM");
      killer = setTimeout(() => kill("SIGKILL"), 2000);
      // A kernel-stuck child cannot be proven ended. Return a bounded, explicitly unconfirmed
      // failure rather than pretending cancellation reclaimed it or hanging the workflow forever.
      hardStop = setTimeout(() => finish(null, null, false), 8000);
    };
    const abort = () => stop("cancelled");
    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => {
      if (out.length + text.length > 128 * 1024) stop("output_limit");
      else out += text;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      errorCode = /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code ?? "") ? error.code : "spawn_failed";
    });
    child.once("close", async (code, signal) => {
      if (finished) return;
      if (groupAlive()) {
        if (!stopped) errorCode = "process_group_leaked";
        kill("SIGTERM");
        const gentle = Date.now() + 2000;
        while (!finished && groupAlive() && Date.now() < gentle)
          await new Promise((done) => setTimeout(done, 50));
        if (finished) return;
        if (groupAlive()) kill("SIGKILL");
        const deadline = Date.now() + 3000;
        while (!finished && groupAlive() && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 50));
      }
      finish(code, signal, !groupAlive());
    });
  });
}
