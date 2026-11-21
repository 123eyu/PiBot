import { spawn } from "node:child_process";

/** Fixed developer commands only. Cancellation settles after close, before callers clean files. */
export function runInstallCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const output: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error) => {
      if (failure) return;
      failure = reason;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 2000);
      escalation.unref();
    };
    const abort = () => stop(new Error("install_command_aborted"));
    const timer = setTimeout(() => stop(new Error("install_command_timeout")), timeoutMs);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 1 << 20) stop(new Error("install_command_output_limit"));
      else output.push(bytes);
    });
    child.once("error", () => stop(new Error("install_command_failed")));
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("install_command_failed"));
      else resolve(Buffer.concat(output).toString("utf8").trim());
    });
    if (signal.aborted) abort();
  });
}
