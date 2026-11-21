import { spawn } from "node:child_process";

/** Fixed host probes only: never accept an agent's program, script or arguments here. */
export async function probe(
  program: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const active = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    const child = spawn(program, [...args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      signal: active,
    });
    let body = "";
    let failed: unknown;
    child.stdout.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body) > 8192) {
        failed = new Error("computer_probe_output_limit");
        child.kill();
      }
    });
    child.once("error", (error) => {
      failed = error;
    });
    child.once("close", (code) =>
      failed || code !== 0
        ? reject(new Error("computer_session_unavailable"))
        : resolve(body.trim()),
    );
  });
}
