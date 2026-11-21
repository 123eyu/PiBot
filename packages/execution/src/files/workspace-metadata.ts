import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileIdentity, sameFile } from "../core/file-identity.ts";
import { ExecError, type FileContext } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";

export interface WorkspaceStat {
  kind: "file" | "directory" | "blocked";
  size: number;
  device: string;
  inode: string;
  links: string;
  version: string;
}
export interface WorkspacePage {
  entries: { name: string; kind: WorkspaceStat["kind"] }[];
  version: string;
  offset: number;
  more: boolean;
}
async function checked(input: FileContext & { path: string }) {
  input.signal.throwIfAborted();
  await verifyWorkspace(input.rootIdentities, input.signal);
  const target = resolve(input.cwd, input.path);
  const root = input.rootIdentities
    ?.filter((r) => {
      const rel = relative(r.canonicalPath, target);
      return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
    })
    .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0];
  if (!root || (input.expectedPath && target !== input.expectedPath))
    throw new ExecError("outside_workplace");
  let path = root.canonicalPath;
  for (const part of relative(path, target).split(sep).filter(Boolean)) {
    path = join(path, part);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new ExecError("outside_workplace");
    input.signal.throwIfAborted();
  }
  if ((await realpath(target)) !== target) throw new ExecError("outside_workplace");
  return target;
}
export async function inspectPath(
  input: FileContext & { path: string },
): Promise<WorkspaceStat | null> {
  input = { ...input, signal: AbortSignal.any([input.signal, AbortSignal.timeout(20000)]) };
  try {
    const path = await checked(input);
    const info = await lstat(path, { bigint: true });
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ExecError("file_failed");
    if (info.isFile()) {
      const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const actual = await handle.stat({ bigint: true });
        if (!actual.isFile() || !sameFile(info, actual) || (await realpath(path)) !== path)
          throw new ExecError("outside_workplace");
      } finally {
        await handle.close();
      }
    }
    await verifyWorkspace(input.rootIdentities, input.signal);
    input.signal.throwIfAborted();
    return {
      kind: info.isSymbolicLink()
        ? "blocked"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "blocked",
      size: Number(info.size),
      ...fileIdentity(info),
      links: String(info.nlink),
      version: createHash("sha256")
        .update([path, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"))
        .digest("hex"),
    };
  } catch (error) {
    input.signal.throwIfAborted();
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR"].includes(String(error.code))
    )
      return null;
    throw error;
  }
}
/** Page order is valid only for this exact directory version; no symlink grants are returned. */
export async function listEntries(
  input: FileContext & { path: string; offset?: number; limit?: number; version?: string },
): Promise<WorkspacePage> {
  input = { ...input, signal: AbortSignal.any([input.signal, AbortSignal.timeout(20000)]) };
  const offset = input.offset ?? 0;
  const requestedLimit = input.limit ?? 200;
  const limit = Math.min(requestedLimit, 10000 - offset);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= 10000 ||
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 200
  )
    throw new ExecError("invalid_input");
  const before = await inspectPath(input);
  if (before?.kind !== "directory" || (input.version && input.version !== before.version))
    throw new ExecError("file_conflict");
  const dir = await opendir(await checked(input));
  const entries: WorkspacePage["entries"] = [];
  let scanned = 0,
    more = false;
  try {
    while (scanned < offset + limit) {
      input.signal.throwIfAborted();
      const entry = await dir.read();
      if (!entry) break;
      scanned++;
      if (scanned <= offset) continue;
      entries.push({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? "blocked"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "blocked",
      });
    }
    more = !!(await dir.read());
  } finally {
    await dir.close();
  }
  if ((await inspectPath(input))?.version !== before.version) throw new ExecError("file_conflict");
  return { entries, version: before.version, offset: scanned, more };
}
