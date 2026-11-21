import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
// Optional sandbox-local runtime directory; normal development still uses .codex/.
export const runtimeDirectory = resolve(process.env.PIBOT_TOOLS_DIR ?? join(projectRoot, ".codex"));

export function capture(command: string, args: string[], cwd = projectRoot): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")}: ${result.stderr.trim() || result.status}`);
  return result.stdout.trimEnd();
}

export function run(
  command: string,
  args: string[],
  cwd = projectRoot,
  env = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")}: ${signal ?? code}`)),
    );
  });
}

export function pnpm(args: string[], cwd = projectRoot, env = process.env): Promise<void> {
  // pnpm 12 is a native executable, so only the JS entry of older pnpm versions may go
  // through node; a native entry is spawned directly, which also avoids needing a shell
  // for pnpm.cmd on Windows.
  const entry = process.env.npm_execpath;
  if (!entry) return run("pnpm", args, cwd, env);
  if (!/\.[cm]?js$/i.test(entry)) return run(entry, args, cwd, env);
  return run(process.execPath, [entry, ...args], cwd, env);
}

export function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
