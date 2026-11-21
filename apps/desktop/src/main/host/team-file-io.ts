import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { sameFile } from "@pibot/execution/file-identity";
import { RpcError, RpcErrorCodes, TEAM_ARCHIVE_MAX_BYTES } from "@pibot/protocol";

// A version-3 `.pibot` is a zip of up to 20 MB; version 1/2 JSON files stay within 1 MB.
export const TEAM_BYTES = TEAM_ARCHIVE_MAX_BYTES;
const invalid = () => new RpcError(RpcErrorCodes.invalidParams, "team_file_invalid");
// Bigint stats: NTFS file IDs exceed a double, so number identities can alias nearby files.
function sameVersion(a: BigIntStats, b: BigIntStats) {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
export async function inspectTeamFile(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (extname(path).toLowerCase() !== ".pibot") throw invalid();
  const stat = await lstat(path, { bigint: true });
  signal.throwIfAborted();
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) > TEAM_BYTES) throw invalid();
  const canonical = await realpath(path);
  signal.throwIfAborted();
  // Parent aliases are allowed after canonicalization, but the chosen file cannot itself be a link.
  if (basename(canonical) !== basename(path)) throw invalid();
  return { path: canonical, stat };
}
export async function readTeamFile(
  selected: Awaited<ReturnType<typeof inspectTeamFile>>,
  signal: AbortSignal,
) {
  const actual = await inspectTeamFile(selected.path, signal);
  if (!sameVersion(actual.stat, selected.stat)) throw invalid();
  const file = await open(actual.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    signal.throwIfAborted();
    if (!sameVersion(await file.stat({ bigint: true }), selected.stat)) throw invalid();
    const buffer = Buffer.alloc(TEAM_BYTES + 1);
    let offset = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      offset += bytesRead;
      if (offset > TEAM_BYTES) throw invalid();
      if (!bytesRead) break;
    }
    signal.throwIfAborted();
    if (
      !sameVersion(await file.stat({ bigint: true }), selected.stat) ||
      !sameVersion(await lstat(actual.path, { bigint: true }), selected.stat)
    )
      throw invalid();
    // Raw bytes; brain tells a v3 zip from a v1/v2 JSON file and checks either one.
    return buffer.subarray(0, offset).toString("base64");
  } finally {
    await file.close();
  }
}

export async function saveTeamFile(path: string, text: string | Buffer, signal: AbortSignal) {
  if (Buffer.byteLength(text) > TEAM_BYTES || extname(path).toLowerCase() !== ".pibot")
    throw invalid();
  signal.throwIfAborted();
  const parent = await realpath(dirname(resolve(path)));
  const parentStat = await lstat(parent, { bigint: true });
  const target = join(parent, basename(path));
  const existing = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw invalid();
  const temporary = join(parent, `.pibot-${randomUUID()}.tmp`);
  let written = false;
  try {
    signal.throwIfAborted();
    const file = await open(temporary, "wx", 0o600);
    written = true;
    try {
      await file.writeFile(
        text,
        typeof text === "string" ? { encoding: "utf8", signal } : { signal },
      );
      await file.sync();
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    const currentParent = await lstat(parent, { bigint: true });
    if (
      currentParent.isSymbolicLink() ||
      !sameFile(currentParent, parentStat) ||
      (await realpath(parent)) !== parent
    )
      throw invalid();
    const current = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing ? !current || !sameVersion(existing, current) : !!current) throw invalid();
    signal.throwIfAborted();
    // Only replace the exact save-dialog target after a complete private temporary write.
    await rename(temporary, target);
  } finally {
    if (written) await rm(temporary, { force: true });
  }
}

/** A display name suggests one basename, never a directory or a platform device name. */
export function teamExportFilename(name = "Pi Bot") {
  const stem = name
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .replace(/[. ]+$/u, "")
    .slice(0, 100)
    .trim();
  const safe =
    !stem || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem) ? "Pi Bot" : stem;
  return `${safe.replace(/\.pibot$/iu, "")}.pibot`;
}
