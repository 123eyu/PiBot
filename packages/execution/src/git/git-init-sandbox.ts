import { dirname, resolve } from "node:path";
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { canonicalPath, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

/** Absolute globs cover every effective write root and future repo without interpreting root names. */
export function gitMetadataWriteDenies(platform: NodeJS.Platform, allowGitConfig: boolean) {
  // SRT 0.0.79 drops write globs on Linux. This rule must never be advertised as protection there.
  if (platform !== "darwin") return [];
  return ["/**/.git/hooks", ...(allowGitConfig ? [] : ["/**/.git/config"])];
}

/** SRT adds writable directories independently of allowWrite; exclude them from both Git phases. */
export async function gitDefaultWriteDenies(roots: string[]) {
  const paths = new Set<string>();
  for (const path of getDefaultWritePaths()) {
    // These are stdio/device files, never directory creation roots. Retain the SDK's I/O contract.
    if (path.startsWith("/dev/")) continue;
    for (const candidate of [resolve(path), await canonicalPath(path, dirname(path))]) {
      if (roots.some((root) => within(root, candidate))) continue;
      // A deny covering the authorized root would also deny mkdir there. Do not silently broaden it.
      if (roots.some((root) => within(candidate, root)))
        throw new ExecError("isolation_unavailable");
      paths.add(candidate);
    }
  }
  return [...paths];
}
