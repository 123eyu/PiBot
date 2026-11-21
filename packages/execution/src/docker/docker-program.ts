import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

export function dockerPrograms(platform: NodeJS.Platform, env: Readonly<NodeJS.ProcessEnv>) {
  if (platform === "darwin")
    return [
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
      "/opt/homebrew/bin/docker",
      "/usr/local/bin/docker",
    ];
  if (platform === "win32") {
    const base = Object.entries(env).find(([key]) => key.toLowerCase() === "programfiles")?.[1];
    return base && win32.isAbsolute(base)
      ? [win32.join(base, "Docker", "Docker", "resources", "bin", "docker.exe")]
      : [];
  }
  return ["/usr/bin", "/usr/local/bin", "/bin", "/snap/bin"].map((base) =>
    posix.join(base, "docker"),
  );
}

/** A user-writable PATH must never choose the executable for the privileged Docker channel. */
export async function dockerProgram(
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
  writeRoots: readonly string[],
  signal: AbortSignal,
) {
  for (const candidate of dockerPrograms(platform, env)) {
    signal.throwIfAborted();
    try {
      const file = await realpath(candidate);
      if (writeRoots.some((root) => within(root, candidate) || within(root, file))) continue;
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      signal.throwIfAborted();
      return file;
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code))
        )
      )
        throw error;
    }
  }
  throw new ExecError("command_not_found");
}
