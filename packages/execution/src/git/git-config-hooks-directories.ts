import { type BigIntStats, lstatSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileIdentity } from "../core/file-identity.ts";
import { within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { hooksPathValue } from "./git-config-intent.ts";
export type HookDirectory = {
  path: string;
  device: string;
  inode: string;
  mode: string;
  owner: string;
  group: string;
  birth: string;
};
function budget(signal: AbortSignal) {
  const deadline = performance.now() + 1000;
  return () => {
    signal.throwIfAborted();
    if (performance.now() > deadline) throw new ExecError("authorization_changed");
  };
}
function directory(path: string, check: () => void): HookDirectory {
  check();
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    check();
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
    )
      throw new ExecError("outside_workplace");
    throw error;
  }
  check();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExecError("outside_workplace");
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    check();
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
    )
      throw new ExecError("outside_workplace");
    throw error;
  }
  check();
  if (canonical !== path) throw new ExecError("outside_workplace");
  // Directory mtimes/ctimes change when our own config.lock is created; entity and access metadata do not.
  return {
    path,
    // Compared with workspace root identities (git-config-hooks-path.ts): canonical spelling.
    ...fileIdentity(stat),
    mode: String(stat.mode),
    owner: String(stat.uid),
    group: String(stat.gid),
    birth: String(stat.birthtimeNs),
  };
}
export function hookDirectoryChain(primary: string, path: string, signal: AbortSignal) {
  const check = budget(signal);
  if (!hooksPathValue(path) || !within(primary, path)) throw new ExecError("outside_workplace");
  const parts = relative(primary, path).split(sep).filter(Boolean);
  if (parts.length > 256) throw new ExecError("outside_workplace");
  const directories = [directory(primary, check)];
  let current = primary;
  for (const part of parts) {
    current = join(current, part);
    directories.push(directory(current, check));
  }
  check();
  return directories;
}

export function verifyHookDirectories(directories: readonly HookDirectory[], signal: AbortSignal) {
  const check = budget(signal);
  for (const expected of directories) {
    if (JSON.stringify(directory(expected.path, check)) !== JSON.stringify(expected))
      throw new ExecError("authorization_changed");
  }
  check();
}
