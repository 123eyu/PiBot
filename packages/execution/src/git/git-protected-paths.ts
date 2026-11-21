import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { sameFile } from "../core/file-identity.ts";
import { canonicalPath, missing, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

export interface LinuxGitWriteBoundary {
  roots: string[];
  permitsRead(path: string): boolean;
  signal: AbortSignal;
  initialization?: { gitDirectory: string; phase: "directories" | "initialize" };
}

/** SRT's default file depth 3 covers repositories at the root and one directory below it. */
export async function linuxGitWriteDenies(input: LinuxGitWriteBoundary): Promise<string[]> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 2000);
  const signal = AbortSignal.any([input.signal, stop.signal]);
  const paths = new Set<string>();
  const repositories = new Set<string>();
  const mounts = new Set<string>();
  let roots: string[] = [];
  let entries = 0;
  let directories = 0;
  function check() {
    if (input.signal.aborted) throw new ExecError("command_failed", "cancelled");
    if (signal.aborted) throw new ExecError("isolation_unavailable", "timeout");
  }
  function deny(path: string) {
    paths.add(path);
    const root = roots.find((root) => within(root, path));
    if (!root) throw new ExecError("outside_workplace");
    // Bound the metadata contribution too; SRT still owns the complete profile/mount ceiling.
    let ancestor = path;
    while (within(root, ancestor)) {
      mounts.add(ancestor);
      if (ancestor === root) break;
      ancestor = dirname(ancestor);
    }
    if (paths.size > 256 || mounts.size > 512) throw new ExecError("isolation_unavailable");
  }
  function protect(gitDirectory: string, fileOnly = false) {
    const init = input.initialization;
    // Only the trusted fixed mkdir phase may omit the extra pin for its own missing target.
    if (init?.phase === "directories" && gitDirectory === init.gitDirectory) return;
    repositories.add(gitDirectory);
    if (repositories.size > 128) throw new ExecError("isolation_unavailable");
    if (fileOnly) deny(gitDirectory);
    else {
      deny(join(gitDirectory, "hooks"));
      if (init?.phase !== "initialize" || gitDirectory !== init.gitDirectory)
        deny(join(gitDirectory, "config"));
    }
  }
  const descriptor = (fd: number) => join("/proc/self/fd", String(fd));
  async function fixedDirectory(path: string, via = path) {
    check();
    if (++directories > 256) throw new ExecError("isolation_unavailable");
    const before = await lstat(via, { bigint: true });
    check();
    if (!before.isDirectory() || before.isSymbolicLink()) throw new ExecError("outside_workplace");
    const handle = await open(
      via,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat({ bigint: true });
      check();
      if (!sameFile(info, before) || (await realpath(descriptor(handle.fd))) !== path)
        throw new ExecError("outside_workplace");
      check();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async function inspectGit(path: string, via: string, rootLevel: boolean) {
    check();
    if (!input.permitsRead(path)) return;
    try {
      const info = await lstat(via);
      check();
      // A gitdir file or link is only protected as an entry. Never read or follow its target.
      protect(path, !info.isDirectory() || info.isSymbolicLink());
    } catch (error) {
      check();
      // No search permission on the parent: the command, running as this uid with every
      // capability dropped, cannot reach this .git either.
      if (denied(error)) return;
      if (!missing(error)) throw error;
      if (rootLevel) protect(path);
    }
  }
  async function scan(root: string) {
    if (!input.permitsRead(root)) return;
    const gitDirectory = basename(root) === ".git" ? root : join(root, ".git");
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      // A not-yet-created SDK default root can still receive a public literal deny.
      info = await lstat(root);
    } catch (error) {
      if (!missing(error) || input.roots.includes(root)) throw error;
      check();
      if (input.permitsRead(gitDirectory)) protect(gitDirectory);
      return;
    }
    check();
    if (!info.isDirectory() && !info.isSymbolicLink()) return;
    // ENOENT after this point is a failed scan (including unavailable /proc), not an absent root.
    const handle = await fixedDirectory(root);
    try {
      const pinned = descriptor(handle.fd);
      if (gitDirectory === root) protect(root);
      else await inspectGit(gitDirectory, join(pinned, ".git"), true);
      const dir = await opendir(pinned, { bufferSize: 1 });
      try {
        for (;;) {
          check();
          const entry = await dir.read();
          check();
          if (!entry) break;
          if (++entries > 4096) throw new ExecError("isolation_unavailable");
          if (entries % 32 === 0) await setImmediate(undefined, { signal });
          if (entry.name === ".git" || !entry.isDirectory() || entry.isSymbolicLink()) continue;
          const child = join(root, entry.name);
          if (!input.permitsRead(child)) continue;
          const via = join(pinned, entry.name);
          let nested: FileHandle;
          try {
            nested = await fixedDirectory(child, via);
          } catch (error) {
            // Shared roots hold other users' private directories (Linux /tmp: systemd-private-*,
            // root-owned 0700). Unlistable is not unreachable: with search permission alone the
            // command could still write a known .git there, so check that name directly.
            if (!denied(error)) throw error;
            await inspectGit(join(child, ".git"), join(via, ".git"), false);
            continue;
          }
          try {
            await inspectGit(join(child, ".git"), join(descriptor(nested.fd), ".git"), false);
          } finally {
            await nested.close();
          }
        }
      } finally {
        await dir.close();
      }
    } finally {
      await handle.close();
    }
  }
  try {
    check();
    // SDK convenience roots are writable independently of allowWrite. Denied regions aren't scanned.
    const defaults =
      input.initialization?.phase === "initialize"
        ? []
        : await Promise.all(
            getDefaultWritePaths()
              .filter((path) => !path.startsWith("/dev/"))
              .map((path) => canonicalPath(path, dirname(path))),
          );
    roots = [...new Set([...input.roots, ...defaults])]
      .filter(input.permitsRead)
      .sort((a, b) => b.length - a.length);
    check();
    if (roots.length > 32) throw new ExecError("isolation_unavailable");
    if (input.initialization?.phase === "initialize") {
      if (roots.length !== 1 || roots[0] !== input.initialization.gitDirectory)
        throw new ExecError("outside_workplace");
      protect(input.initialization.gitDirectory);
    } else {
      for (const root of roots) {
        check();
        await scan(root);
      }
    }
    check();
    return [...paths];
  } catch (error) {
    check();
    if (error instanceof ExecError) throw error;
    // Filesystem errors contain private names. A partial scan is never a usable profile.
    throw new ExecError("isolation_unavailable");
  } finally {
    clearTimeout(timer);
  }
}

function denied(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EACCES";
}
