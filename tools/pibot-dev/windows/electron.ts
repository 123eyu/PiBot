import { access, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pnpmEnv, repo } from "../context.ts";
import { command } from "./command.ts";
import { commandReason } from "./protocol.ts";

const COPY =
  "import {cp,constants} from 'node:fs/promises';await cp(process.argv[1],process.argv[2],{recursive:true,dereference:false,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});";
const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Preparation runs in killable child processes; wrapping the old sync cp cannot cancel it. */
export async function ensureElectronAsync(
  worktree: string,
  options: { signal: AbortSignal; run?: typeof command; timeoutMs?: number },
) {
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
  ]);
  const run = options.run ?? command;
  let drained = true;
  const execute = async (executable: string, args: string[]) => {
    signal.throwIfAborted();
    const result = await run(executable, args, {
      signal,
      timeoutMs: 10 * 60_000,
      cwd: worktree,
      env: pnpmEnv,
    });
    if (!result.drained) drained = false;
    const reason = commandReason(result);
    if (reason) throw new Error(`electron_preflight:${reason}`);
    signal.throwIfAborted();
  };
  signal.throwIfAborted();
  const packages = join(worktree, "node_modules", ".pnpm");
  if (!(await exists(packages))) return;
  for (const name of (await readdir(packages)).filter((name) => name.startsWith("electron@"))) {
    signal.throwIfAborted();
    const target = join(packages, name, "node_modules", "electron");
    if ((await exists(join(target, "dist"))) && (await exists(join(target, "path.txt")))) continue;
    const source = join(repo, "node_modules", ".pnpm", name, "node_modules", "electron");
    if ((await exists(join(source, "dist"))) && (await exists(join(source, "path.txt")))) {
      await mkdir(target, { recursive: true });
      const stage = await mkdtemp(join(target, ".pibot-electron-"));
      try {
        await execute(process.execPath, [
          "--input-type=module",
          "-e",
          COPY,
          join(source, "dist"),
          join(stage, "dist"),
        ]);
        await execute(process.execPath, [
          "--input-type=module",
          "-e",
          COPY,
          join(source, "path.txt"),
          join(stage, "path.txt"),
        ]);
        signal.throwIfAborted();
        await rm(join(target, "dist"), { recursive: true, force: true });
        await rename(join(stage, "dist"), join(target, "dist"));
        await rename(join(stage, "path.txt"), join(target, "path.txt"));
      } finally {
        // Unknown child liveness cannot authorize deleting a directory it may still be writing.
        if (drained) await rm(stage, { recursive: true, force: true, maxRetries: 2 });
      }
    } else {
      await execute("pnpm", ["--filter", "@pibot/desktop", "exec", "install-electron"]);
    }
  }
  signal.throwIfAborted();
}
