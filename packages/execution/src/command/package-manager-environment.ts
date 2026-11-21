import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { prepareToolEnvironment } from "./tool-environment.ts";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
/** Reuse a prepared pinned pnpm without giving its global version manager write access. */
export async function preparePackageManagerEnvironment(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
  temp: string,
  signal: AbortSignal,
  roots: readonly string[],
  systemHome: string,
  /** Per-run caches and XDG folders keep sandboxed runs apart; an approved outside run is the
   * user's own terminal and keeps the user's own tool state. */
  pinToolState = true,
) {
  if (pinToolState) await prepareToolEnvironment(platform, env, temp, systemHome, signal);
  // Use the project's already installed toolchain; never install a version as a side effect of a check.
  if (platform === "win32") return;
  let version: string | undefined;
  let directory = cwd;
  for (let depth = 0; depth < 32; depth++) {
    if (
      !roots.some((root) => {
        const name = relative(root, directory);
        return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith("../"));
      })
    )
      break;
    signal.throwIfAborted();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        join(directory, "package.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = await handle.stat();
      if (info.isFile() && info.nlink === 1 && info.size <= 64 * 1024) {
        const buffer = Buffer.alloc(64 * 1024 + 1);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead > 64 * 1024) break;
        const data: unknown = JSON.parse(buffer.subarray(0, read.bytesRead).toString("utf8"));
        if (
          data &&
          typeof data === "object" &&
          "packageManager" in data &&
          typeof data.packageManager === "string"
        ) {
          version = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-zA-Z0-9]+)?$/.exec(
            data.packageManager,
          )?.[1];
          break;
        }
      }
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
        )
      )
        throw error;
      // Missing/invalid manifests cannot select a toolchain; retain the configured PATH.
    } finally {
      await handle?.close();
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!version) return;
  for (const entry of (env.PATH ?? "").split(":")) {
    if (!isAbsolute(entry)) continue;
    signal.throwIfAborted();
    const candidate = join(
      entry,
      ".tools",
      "pnpm",
      version,
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.cjs",
    );
    try {
      const executable = await realpath(candidate);
      await access(executable, constants.R_OK);
      const info = await lstat(temp);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(temp)) !== temp)
        throw new Error("command_temp_changed");
      const bin = await mkdtemp(join(temp, "prepared-tools-"));
      // A fresh private shim cannot be replaced by an earlier command in this run.
      const shim = `#!/bin/sh\nexec node ${shellQuote(executable)} "$@"\n`;
      await writeFile(join(bin, "pnpm"), shim, { flag: "wx", mode: 0o700 });
      env.PATH = `${bin}:${env.PATH ?? ""}`;
      env.npm_config_manage_package_manager_versions = "false";
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
        )
      )
        throw error;
    }
  }
}
