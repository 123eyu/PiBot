import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function runnerDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const override = env.PIBOT_DATA_DIR;
  if (override) return resolve(override);
  const home = homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "Pi Bot Runner");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local && isAbsolute(local)) return join(local, "Pi Bot Runner");
    return join(home, "AppData", "Local", "Pi Bot Runner");
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "pibot-runner");
  return join(home, ".local", "share", "pibot-runner");
}

export async function prepareRunnerDataDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runner_data_dir_insecure");
    return;
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isDirectory() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      throw new Error("runner_data_dir_insecure");
    if ((info.mode & 0o077) !== 0) await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}
