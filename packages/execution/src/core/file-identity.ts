/**
 * The one canonical encoding of a file-system entity's identity (device + inode).
 *
 * Why bigint only: Node's number form of `ino` is a double. NTFS file IDs put the sequence number
 * in the high 16 bits, so real IDs exceed 2^53 and lose their low bits — nearby MFT records then
 * round to the same number (two folders "match") and a recorded number never equals the exact
 * bigint another component reads (Windows sub-task dispatch failed this way). Every recording and
 * checking side therefore reads `{ bigint: true }` stats and goes through these helpers; the
 * parameter type rejects number `Stats` at compile time.
 *
 * Why two spellings: values that a double represents exactly keep the plain decimal form, which is
 * byte-identical to every identity stored before this helper existed (all of macOS/Linux, small
 * Windows IDs). Larger values use `0x` + hex. Older records of such values were written from the
 * rounded double as a decimal (> MAX_SAFE_INTEGER) and can never equal a new `0x` spelling or any
 * new decimal, so a lossy legacy record fails closed ("changed") instead of matching a neighbour.
 */
export interface FileIdentity {
  device: string;
  inode: string;
}
/** Stats read with `{ bigint: true }` (lstat, stat, fstat, FileHandle.stat). */
export interface ExactStatIdentity {
  dev: bigint;
  ino: bigint;
}
const safeLimit = BigInt(Number.MAX_SAFE_INTEGER);

export function encodeIdentityPart(value: bigint): string {
  return value <= safeLimit ? value.toString() : `0x${value.toString(16)}`;
}
export function fileIdentity(stat: ExactStatIdentity): FileIdentity {
  return { device: encodeIdentityPart(stat.dev), inode: encodeIdentityPart(stat.ino) };
}
/** `null` parts mean "not recorded" (for example a path that did not exist yet) and are skipped. */
export function matchesFileIdentity(
  stat: ExactStatIdentity,
  expected: { device: string | null; inode: string | null },
): boolean {
  const current = fileIdentity(stat);
  return (
    (expected.device === null || current.device === expected.device) &&
    (expected.inode === null || current.inode === expected.inode)
  );
}
/** Same entity, for two bigint stats taken within one operation (TOCTOU before / after checks). */
export function sameFile(a: ExactStatIdentity, b: ExactStatIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
/** Stable string key (`device:inode`) for maps, signatures and cache keys. */
export function fileIdentityKey(stat: ExactStatIdentity): string {
  const { device, inode } = fileIdentity(stat);
  return `${device}:${inode}`;
}
