import { lstat, readlink, realpath } from "node:fs/promises";
import { ExecError } from "../core/types.ts";
import { gitResourceIdentity, readGitResource, sameGitIdentity } from "./git-resource-identity.ts";
import type { GitResourceIdentity } from "./git-resource-types.ts";

interface ShellObject {
  identity: GitResourceIdentity;
  mode: number;
  target?: string;
  hash?: string;
}

export interface LinuxGitHookShell {
  program: "/usr/bin/dash";
  objects: readonly ShellObject[];
}

const layout = [
  ["/", undefined],
  ["/usr", undefined],
  ["/usr/bin", undefined],
  ["/bin", "usr/bin"],
  ["/usr/bin/sh", "dash"],
  ["/usr/bin/dash", undefined],
] as const;

/** Only the measured system layout is admitted; this is not a general symlink resolver. */
export async function observeLinuxGitHookShell(signal: AbortSignal): Promise<LinuxGitHookShell> {
  const objects: ShellObject[] = [];
  for (const [path, target] of layout) {
    signal.throwIfAborted();
    const info = await lstat(path);
    const identity = await gitResourceIdentity(path);
    if (!identity || info.uid !== 0) throw new ExecError("isolation_unavailable");
    const mode = info.mode & 0o777;
    if (target !== undefined) {
      if (!info.isSymbolicLink() || (await readlink(path)) !== target)
        throw new ExecError("isolation_unavailable");
      objects.push({ identity, mode, target });
    } else if (path !== "/usr/bin/dash") {
      if (!info.isDirectory() || mode & 0o022 || (await realpath(path)) !== path)
        throw new ExecError("isolation_unavailable");
      // Creating an unrelated system entry is not a change of the trusted ancestor entity.
      objects.push({
        identity: { ...identity, size: "0", modifiedNs: "0", changedNs: "0", links: "0" },
        mode,
      });
    } else {
      if (!info.isFile() || mode & 0o022 || !(mode & 0o111) || (await realpath(path)) !== path)
        throw new ExecError("isolation_unavailable");
      const read = await readGitResource(path, 16 * 1024 * 1024, signal);
      if (!read.hash || !sameGitIdentity(identity, await gitResourceIdentity(path)))
        throw new ExecError("authorization_changed");
      objects.push({ identity, mode, hash: read.hash });
    }
    if (!sameGitIdentity(identity, await gitResourceIdentity(path)))
      throw new ExecError("authorization_changed");
  }
  if ((await realpath("/bin/sh")) !== "/usr/bin/dash") throw new ExecError("isolation_unavailable");
  signal.throwIfAborted();
  return { program: "/usr/bin/dash", objects };
}

export async function revalidateLinuxGitHookShell(
  expected: LinuxGitHookShell,
  signal: AbortSignal,
) {
  if (JSON.stringify(expected) !== JSON.stringify(await observeLinuxGitHookShell(signal)))
    throw new ExecError("authorization_changed");
}
