import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { encodeIdentityPart } from "../core/file-identity.ts";

/** Largest hook / config file that is hashed; anything bigger makes the scan incomplete. */
export const ENTRY_FILE_LIMIT = 1024 * 1024;

/** One observed path. Re-observing it right before launch must give exactly the same record. */
export type BoundPath =
  | { path: string; kind: "absent" }
  | { path: string; kind: "dir" | "other"; id: string }
  | { path: string; kind: "link"; id: string; target: string }
  | { path: string; kind: "file"; id: string; mode: number; size: number; sha256: string };

export class EntryScanIncomplete extends Error {}

const missing = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  ["ENOENT", "ENOTDIR"].includes(String((error as { code: unknown }).code));

/** Reads a regular file without following a final symlink or blocking on a FIFO. */
export function readBoundFile(path: string): { bound: BoundPath; bytes?: Buffer } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return { bound: { path, kind: "absent" } };
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP")
      return { bound: observe(path) };
    throw new EntryScanIncomplete("unreadable");
  }
  try {
    const info = fstatSync(fd, { bigint: true });
    const id = `${encodeIdentityPart(info.dev)}:${encodeIdentityPart(info.ino)}`;
    if (!info.isFile()) return { bound: { path, kind: "other", id } };
    if (info.size > BigInt(ENTRY_FILE_LIMIT)) throw new EntryScanIncomplete("too_large");
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    // A file that grew or shrank while being read is not a stable entry.
    if (offset !== bytes.length || fstatSync(fd).size !== bytes.length)
      throw new EntryScanIncomplete("changing");
    return {
      bound: {
        path,
        kind: "file",
        id,
        mode: Number(info.mode),
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}

/** Metadata only (directories, links, special files); never follows the final component. */
export function observe(path: string): BoundPath {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return { path, kind: "absent" };
    throw new EntryScanIncomplete("unreadable");
  }
  const id = `${encodeIdentityPart(info.dev)}:${encodeIdentityPart(info.ino)}`;
  if (info.isSymbolicLink()) return { path, kind: "link", id, target: readlinkSync(path) };
  if (info.isFile()) return readBoundFile(path).bound;
  return { path, kind: info.isDirectory() ? "dir" : "other", id };
}

/** Follows a symlinked entry once to its canonical target; both records are bound. */
export function followLink(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw new EntryScanIncomplete("unreadable");
  }
}

export function sameBound(a: BoundPath, b: BoundPath) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Re-observes every bound path; any difference means the confirmed entries are not current. */
export function boundCurrent(bound: readonly BoundPath[]): boolean {
  try {
    return bound.every((item) =>
      sameBound(item, item.kind === "file" ? readBoundFile(item.path).bound : observe(item.path)),
    );
  } catch {
    // Unreadable or changing now means it cannot be shown to be the confirmed entry.
    return false;
  }
}
