// Directory-producing PowerShell commands can implicitly read descendants through a pipe.
import { lstat, opendir } from "node:fs/promises";
import { win32 } from "node:path";

export interface WindowsReadEntry {
  path: string;
  directory: boolean;
}

/** Only the local filesystem can attest that each visited entry is a regular file or directory. */
export async function windowsReadEntries(
  directory: string,
  recurse: boolean,
  signal: AbortSignal,
  canVisit: (path: string) => boolean,
): Promise<WindowsReadEntry[] | undefined> {
  const directories = [directory];
  const entries: WindowsReadEntry[] = [];
  while (directories.length) {
    const path = directories.pop();
    if (!path) return;
    signal.throwIfAborted();
    if (!(await lstat(path)).isDirectory()) return;
    signal.throwIfAborted();
    // The iterator closes its directory handle on completion, early return or cancellation.
    for await (const entry of await opendir(path, { bufferSize: 32 })) {
      signal.throwIfAborted();
      if (entries.length >= 256 || (!entry.isDirectory() && !entry.isFile())) return;
      const child = win32.join(path, entry.name);
      if (!canVisit(child)) return;
      entries.push({ path: child, directory: entry.isDirectory() });
      if (recurse && entry.isDirectory()) directories.push(child);
    }
  }
  return entries;
}
