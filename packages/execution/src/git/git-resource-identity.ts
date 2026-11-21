import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { fileIdentity, matchesFileIdentity } from "../core/file-identity.ts";
import { missing } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import type { GitResourceIdentity, GitResourceReason } from "./git-resource-types.ts";

export async function gitResourceIdentity(path: string): Promise<GitResourceIdentity | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    return {
      path,
      // Compared against workspace root identities recorded elsewhere: one canonical spelling.
      ...fileIdentity(info),
      size: String(info.size),
      modifiedNs: String(info.mtimeNs),
      changedNs: String(info.ctimeNs),
      links: String(info.nlink),
      type: info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other",
    };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
export async function gitResourceParent(path: string) {
  let parent = dirname(path);
  for (;;) {
    const identity = await gitResourceIdentity(parent);
    if (identity) return identity;
    const next = dirname(parent);
    if (next === parent) return undefined;
    parent = next;
  }
}
export function sameGitIdentity(
  a: GitResourceIdentity | undefined,
  b: GitResourceIdentity | undefined,
) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only regular, single-link objects inside a verified readable scope reach this reader. */
export async function readGitResource(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ hash?: string; text?: string; reason?: GitResourceReason }> {
  signal.throwIfAborted();
  const before = await gitResourceIdentity(path);
  if (before?.type !== "file") return { reason: "unsupported_layout" };
  if (before.links !== "1") return { reason: "hardlink" };
  if (Number(before.size) > maxBytes) return { reason: "file_limit" };
  if ((await realpath(path)) !== path) return { reason: "alias" };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    signal.throwIfAborted();
    if (!matchesFileIdentity(opened, before)) return { reason: "changed_during_read" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    signal.throwIfAborted();
    if (length > maxBytes) return { reason: "file_limit" };
    const after = await gitResourceIdentity(path);
    const final = await handle.stat({ bigint: true });
    if (
      !sameGitIdentity(before, after) ||
      (await realpath(path)) !== path ||
      String(final.size) !== before.size ||
      String(final.mtimeNs) !== before.modifiedNs ||
      String(final.ctimeNs) !== before.changedNs ||
      String(final.nlink) !== "1"
    )
      return { reason: "changed_during_read" };
    const bytes = buffer.subarray(0, length);
    return { hash: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8") };
  } finally {
    await handle.close();
  }
}

/** Filesystem failures become diagnostic gaps; programming errors must still surface. */
export function rethrowGitInspectionBug(error: unknown): void {
  if (error instanceof ExecError && error.code === "outside_workplace") return;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z0-9]+$/.test(error.code)
  )
    return;
  throw error;
}
