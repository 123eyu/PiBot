import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { fileIdentity, matchesFileIdentity } from "../core/file-identity.ts";
import { missing } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import type { GitPublicationDirectory, GitPublicationPlan } from "./git-config-publish-types.ts";
import { sameGitIdentity } from "./git-resource-identity.ts";
import type { GitResourceIdentity } from "./git-resource-types.ts";

export const configurationHash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

export function configurationIdentitySync(path: string): GitResourceIdentity | undefined {
  try {
    const info = lstatSync(path, { bigint: true });
    return {
      path,
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

/** Nonblocking even if a regular file is replaced by a FIFO between lstat and open. */
export function configurationReadSync(path: string): {
  identity?: GitResourceIdentity;
  hash?: string;
} {
  const identity = configurationIdentitySync(path);
  if (!identity) return {};
  if (
    identity.type !== "file" ||
    identity.links !== "1" ||
    Number(identity.size) > 65_536 ||
    realpathSync(path) !== path
  )
    throw new ExecError("file_conflict");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !matchesFileIdentity(opened, identity))
      throw new ExecError("file_conflict");
    const bytes = Buffer.alloc(65_537);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const final = fstatSync(fd, { bigint: true });
    if (
      length > 65_536 ||
      !sameGitIdentity(identity, configurationIdentitySync(path)) ||
      realpathSync(path) !== path ||
      String(final.size) !== identity.size ||
      String(final.mtimeNs) !== identity.modifiedNs ||
      String(final.ctimeNs) !== identity.changedNs ||
      String(final.nlink) !== "1"
    )
      throw new ExecError("file_conflict");
    return { identity, hash: configurationHash(bytes.subarray(0, length)) };
  } finally {
    closeSync(fd);
  }
}

export async function pinConfigurationDirectories(
  plan: GitPublicationPlan,
  pins: GitPublicationDirectory[],
  signal: AbortSignal,
) {
  for (const item of plan.directories) {
    signal.throwIfAborted();
    if (pins.some((pin) => pin.path === item.path)) continue;
    const handle = await open(
      item.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    pins.push({ ...item, handle });
    verifyConfigurationDirectories(pins);
  }
}

export function verifyConfigurationDirectories(pins: readonly GitPublicationDirectory[]) {
  for (const pin of pins) {
    const identity = configurationIdentitySync(pin.path),
      fd = fstatSync(pin.handle.fd, { bigint: true });
    if (
      identity?.type !== "directory" ||
      identity.device !== pin.device ||
      identity.inode !== pin.inode ||
      !fd.isDirectory() ||
      !matchesFileIdentity(fd, pin) ||
      realpathSync(pin.path) !== pin.path
    )
      throw new ExecError("file_conflict");
  }
}

export function verifyConfigurationSource(plan: GitPublicationPlan, hash: string | undefined) {
  if (plan.absentPaths.some((path) => configurationIdentitySync(path)))
    throw new ExecError("file_conflict");
  const current = configurationReadSync(plan.targetPath);
  if (!sameGitIdentity(plan.expectedIdentity, current.identity) || current.hash !== hash)
    throw new ExecError("file_conflict");
}
