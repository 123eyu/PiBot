import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { sameFile } from "@pibot/execution/file-identity";
import { BackgroundDescriptorSchema } from "@pibot/protocol/background";
import { readDescriptor } from "@pibot/sdk/node";
import { reserveLoopback } from "./background-loopback.ts";
import type { WindowsBackgroundSecurity } from "./windows-background-security.ts";

/**
 * sun_path holds 104 bytes on macOS and 108 on Linux, terminator included; a longer path makes
 * listen() fail. The socket stays in the data folder's private runtime directory instead of a
 * short temp path: sandboxed agent commands may write OS temp (only pibot-srt is write-denied),
 * and a socket replaced there would receive the owner token every client sends; the SDK also
 * accepts no endpoint outside the runtime directory.
 */
const SOCKET_PATH_MAX_BYTES = 100;
const SOCKET_NAME = "owner.sock";
/** Bytes left for the data folder's real path; shown to the user when it is too long. */
export const DATA_DIR_SOCKET_BUDGET_BYTES =
  SOCKET_PATH_MAX_BYTES - Buffer.byteLength(join("/", "background-runtime", SOCKET_NAME));
const socketEndpoint = (directory: string) => {
  const endpoint = join(directory, SOCKET_NAME);
  if (Buffer.byteLength(endpoint) > SOCKET_PATH_MAX_BYTES)
    throw new Error("background_socket_path_too_long");
  return endpoint;
};
/**
 * The GUI checks before spawning an owner: an owner that fails this exits through its normal stop
 * (code 0), which the launch loop reads as a lost single-instance race and respawns until its
 * budget runs out, so the user waited a minute for a misleading "startup timed out".
 */
export async function assertBackgroundSocketFits(dataDir: string) {
  // Windows owners listen on loopback TCP; there is no socket path.
  if (process.platform === "win32") return;
  socketEndpoint(join(await realpath(dataDir), "background-runtime"));
}
export async function backgroundDirectory(
  dataDir: string,
  windows?: WindowsBackgroundSecurity,
  signal?: AbortSignal,
) {
  if (process.platform === "win32") {
    if (!windows) throw new Error("background_windows_verifier_required");
    return windows.directory(dataDir, true, signal);
  }
  const root = await realpath(dataDir);
  const directory = join(root, "background-runtime");
  await mkdir(directory, { mode: 0o700 });
  return directory;
}
export async function secureDirectory(
  dataDir: string,
  windows?: WindowsBackgroundSecurity,
  signal?: AbortSignal,
) {
  if (process.platform === "win32") {
    if (!windows) throw new Error("background_windows_verifier_required");
    return windows.directory(dataDir, true, signal);
  }
  let directory: string;
  try {
    directory = await backgroundDirectory(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    directory = join(await realpath(dataDir), "background-runtime");
  }
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error("background_runtime_permissions");
  return directory;
}
export const readBackgroundDescriptor = (
  dataDir: string,
  windows?: WindowsBackgroundSecurity,
  signal?: AbortSignal,
) => readDescriptor(dataDir, windows?.discovery, signal);
export { readBackgroundDescriptor as readDescriptor };
export async function reserveDescriptor(
  dataDir: string,
  version: string,
  writerLockHeld = false,
  windows?: WindowsBackgroundSecurity,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const directory = await secureDirectory(dataDir, windows, signal);
  const loopback = process.platform === "win32" ? await reserveLoopback(signal) : undefined;
  const endpoint = loopback?.endpoint ?? socketEndpoint(directory);
  const path = join(directory, "owner.json");
  const lock = join(directory, "owner.lock");
  const createFile = (path: string, active?: AbortSignal) =>
    windows ? windows.createPrivateFile(directory, path, active) : open(path, "wx", 0o600);
  // Never remove a previous owner's lock on PID/mtime heuristics, including after a crash.
  const claim = async () => {
    try {
      return await createFile(lock, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !writerLockHeld) throw error;
      const previous = await readBackgroundDescriptor(dataDir, windows, signal);
      // Ownership is proven by exact (bigint) identity; NTFS IDs exceed a double's precision.
      const claimStat = await lstat(lock, { bigint: true });
      if (windows) await windows.file(directory, lock, signal);
      if (
        !claimStat.isFile() ||
        claimStat.isSymbolicLink() ||
        (windows
          ? claimStat.nlink !== 1n
          : Number(claimStat.uid) !== process.getuid?.() || Number(claimStat.mode) & 0o077) ||
        claimStat.size > 4096n
      )
        throw error;
      const claimed = BackgroundDescriptorSchema.parse(JSON.parse(await readFile(lock, "utf8")));
      // A complete descriptor alone cannot authorize deletion of an unrelated/unknown claim.
      if (
        claimed.instance !== previous.instance ||
        claimed.pid !== previous.pid ||
        claimed.version !== previous.version ||
        claimed.endpoint !== previous.endpoint ||
        claimed.token !== previous.token
      )
        throw error;
      const dead = (pid: number) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw failure;
        }
      };
      // Only the canonical Electron owner lock plus two confirmed deaths permits recovery.
      // A null child is safe because its PID is persisted before bootstrap can open SQLite.
      if (!dead(previous.pid) || (previous.utilityPid !== null && !dead(previous.utilityPid)))
        throw error;
      const current = await readBackgroundDescriptor(dataDir, windows, signal);
      const currentClaim = await lstat(lock, { bigint: true });
      if (current.instance !== previous.instance || current.utilityPid !== previous.utilityPid)
        throw error;
      if (!sameFile(currentClaim, claimStat)) throw error;
      const socket = loopback
        ? undefined
        : await lstat(endpoint).catch((failure: NodeJS.ErrnoException) => {
            if (failure.code === "ENOENT") return undefined;
            throw failure;
          });
      if (socket && (!socket.isSocket() || socket.uid !== process.getuid?.())) throw error;
      if (socket) await unlink(endpoint);
      await unlink(path);
      await unlink(lock);
      return createFile(lock, signal);
    }
  };
  const file = await claim().catch(async (error) => {
    await loopback?.close();
    throw error;
  });
  let descriptor: ReturnType<typeof BackgroundDescriptorSchema.parse>;
  const identity = await file.stat({ bigint: true }).catch(async (error) => {
    // Without inode evidence the claim is unknown; retain it, but never leak the file handle.
    await file.close();
    await loopback?.close();
    throw error;
  });
  let publishedIdentity = identity;
  const unlinkOwned = async (target: string) => {
    const stat = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const owned = target === path ? publishedIdentity : identity;
    if (stat && sameFile(stat, owned)) await unlink(target);
  };
  const writeFileDescriptorCopy = async () => {
    // Electron's canonical role lock and owner.lock exclude other publishers. Unlike POSIX's
    // hardlink publication, Windows discovery accepts only one-link files under the private DACL.
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) throw new Error("background_owner_changed");
    const temporary = join(directory, `descriptor-${descriptor.instance}-${randomUUID()}.tmp`);
    const output = await createFile(temporary, signal);
    try {
      publishedIdentity = await output.stat({ bigint: true });
      await output.writeFile(JSON.stringify(descriptor));
      await output.sync();
      await output.close();
      await rename(temporary, path);
    } finally {
      await output.close();
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  try {
    descriptor = BackgroundDescriptorSchema.parse({
      protocol: 1,
      instance: randomUUID(),
      version,
      endpoint,
      token: randomBytes(32).toString("hex"),
      pid: process.pid,
      utilityPid: null,
    });
    try {
      await file.writeFile(JSON.stringify(descriptor));
      await file.sync();
    } finally {
      await file.close();
    }
    // Publish only a complete, synced descriptor. The exclusive claim remains held throughout.
    if (windows) await writeFileDescriptorCopy();
    else await link(lock, path);
  } catch (error) {
    // This inode was exclusively created here and no child has been started yet. Never
    // remove an existing descriptor belonging to another owner, even on publication failure.
    await file.close();
    await unlinkOwned(path);
    await unlinkOwned(lock);
    await loopback?.close();
    throw error;
  }
  let updates = Promise.resolve();
  let releasedDescriptor = false,
    releasedClaim = false;
  let releasing: Promise<void> | undefined;
  const updateUtility = (pid: number | null, expected?: number) => {
    const pending = updates.then(async () => {
      if (expected !== undefined && descriptor.utilityPid !== expected) return;
      const current = await readBackgroundDescriptor(dataDir, windows);
      if (current.instance !== descriptor.instance || current.utilityPid !== descriptor.utilityPid)
        throw new Error("background_owner_changed");
      const value = BackgroundDescriptorSchema.parse({ ...descriptor, utilityPid: pid });
      const temporary = join(directory, `descriptor-${descriptor.instance}-${randomUUID()}.tmp`);
      const handle = await createFile(temporary);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
        await handle.close();
        await rename(temporary, path);
        descriptor.utilityPid = pid;
      } finally {
        await handle.close();
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
    updates = pending.catch(() => {
      /* The caller retains ownership and prevents bootstrap on publication failure. */
    });
    return pending;
  };
  return {
    descriptor,
    loopback,
    utility(pid: number) {
      return updateUtility(pid);
    },
    // Only an observed exit of this exact child authorizes clearing its published PID.
    clearUtility(exitedPid: number) {
      return updateUtility(null, exitedPid);
    },
    async socketPrivate() {
      if (!loopback) await chmod(endpoint, 0o600);
    },
    release() {
      if (releasing) return releasing;
      const pending = (async () => {
        await updates;
        if (!releasedDescriptor) {
          const current = await readBackgroundDescriptor(dataDir, windows);
          if (current.instance !== descriptor.instance) throw new Error("background_owner_changed");
        }
        if (!releasedClaim) {
          const claimed = BackgroundDescriptorSchema.parse(
            JSON.parse(await readFile(lock, "utf8")),
          );
          if (
            claimed.instance !== descriptor.instance ||
            claimed.pid !== descriptor.pid ||
            claimed.token !== descriptor.token
          )
            throw new Error("background_owner_changed");
        }
        // Successful own unlinks are remembered; an interrupted two-file release can retry
        // without treating absence as evidence that an unknown external owner was removed.
        if (!releasedDescriptor) {
          await unlink(path);
          releasedDescriptor = true;
        }
        if (!releasedClaim) {
          await unlink(lock);
          releasedClaim = true;
        }
        await loopback?.close();
      })();
      releasing = pending;
      void pending.then(
        () => {
          if (releasing === pending) releasing = undefined;
        },
        () => {
          if (releasing === pending) releasing = undefined;
        },
      );
      return pending;
    },
  };
}
