import type { WorkspaceSnapshot } from "@pibot/protocol";

/**
 * The boundary a routine's consent is compared with and stored as, without the read-only folders
 * one run received for itself. Those folders sit inside the primary (the
 * ledger only hands them out then), so they add no read access and only narrow writes; leaving
 * them in would make every earlier "always allow" look like a different workspace once a period
 * has a predecessor, and would tie new consent to one period's folder.
 */
export function withoutTemporaryRoots(boundary: WorkspaceSnapshot, paths: readonly string[]) {
  if (!paths.length) return boundary;
  const temporary = new Set(
    boundary.roots
      .filter((root) => root.role === "readonly" && paths.includes(root.canonicalPath))
      .map((root) => root.canonicalPath),
  );
  if (!temporary.size) return boundary;
  return {
    ...boundary,
    roots: boundary.roots.filter((root) => !temporary.has(root.canonicalPath)),
    readRoots: boundary.readRoots.filter((root) => !temporary.has(root)),
    denyWriteRoots: boundary.denyWriteRoots.filter((root) => !temporary.has(root)),
  };
}
