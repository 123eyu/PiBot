import { spawn } from "node:child_process";

export async function packageCommand(program: string, args: string[], cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      signal: AbortSignal.timeout(600_000),
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`runner_build_command_failed:${code ?? "signal"}`)),
    );
  });
}
