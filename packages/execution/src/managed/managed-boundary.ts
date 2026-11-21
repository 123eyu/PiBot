import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileIdentity, matchesFileIdentity } from "../core/file-identity.ts";
import { ExecError } from "../core/types.ts";

export interface ManagedPathIdentity {
  path: string;
  device: string;
  inode: string;
}
export async function managedIdentity(path: string): Promise<ManagedPathIdentity> {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path) || resolve(path) !== path)
    throw new ExecError("outside_workplace");
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new ExecError("outside_workplace");
  return { path, ...fileIdentity(info) };
}
/** Pins the authorized entity; every dispatch repeats both pathname and open-handle checks. */
export async function holdManagedPaths(
  identities: ManagedPathIdentity[],
  signal: AbortSignal,
  authorize: () => void,
) {
  const handles: { identity: ManagedPathIdentity; handle: FileHandle }[] = [];
  const check = async (skip: ReadonlySet<string> = new Set()) => {
    signal.throwIfAborted();
    authorize();
    for (const { identity, handle } of handles) {
      if (skip.has(identity.path)) continue;
      const [current, pinned] = await Promise.all([
        managedIdentity(identity.path),
        handle.stat({ bigint: true }),
      ]);
      if (
        current.device !== identity.device ||
        current.inode !== identity.inode ||
        !matchesFileIdentity(pinned, identity)
      )
        throw new ExecError("outside_workplace");
    }
    signal.throwIfAborted();
    authorize();
  };
  const close = async () => {
    await Promise.all(handles.map(({ handle }) => handle.close()));
  };
  try {
    for (const identity of identities) {
      signal.throwIfAborted();
      authorize();
      const handle = await open(
        identity.path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push({ identity, handle });
      await check();
    }
    return { check, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export const managedQuote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
