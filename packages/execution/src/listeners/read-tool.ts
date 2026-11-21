import { spawn } from "node:child_process";
import { ExecError } from "../core/types.ts";

const MAX_OUTPUT = 1024 * 1024;

/**
 * Runs a fixed, read-only system tool (lsof / PowerShell) for the background monitor. Arguments
 * are argv, never a shell string; output is bounded and the call has a hard deadline.
 */
export function readTool(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderrPresent: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ExecError("command_failed", "cancelled"));
    const child = spawn(file, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderrPresent = false;
    let settled = false;
    const finish = (error?: ExecError, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        child.kill("SIGKILL");
        child.unref();
        reject(error);
      } else resolve({ code, stdout, stderrPresent });
    };
    const abort = () => finish(new ExecError("command_failed", "cancelled"));
    const timer = setTimeout(() => finish(new ExecError("command_failed", "timeout")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT) finish(new ExecError("output_failed"));
    });
    // lsof uses exit 1 for both an empty match and real errors. Retain only the presence,
    // never diagnostic content, so a permissions/tool error cannot masquerade as no listeners.
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length) stderrPresent = true;
    });
    child.once("error", () => finish(new ExecError("command_failed")));
    child.once("close", (code) => finish(undefined, code));
  });
}
