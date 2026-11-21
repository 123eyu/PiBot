// Incremental tsc data inside `.cache/tsc` (declaration output plus tsbuildinfo, see
// tools/dev/tsconfig-references.ts) saves minutes per check, but it is only valid for the sources it
// was built from, and tsc decides freshness by file mtime (a cache copied into a worktree
// was newer than the sources it was built from, so a changed source was never recompiled and the
// stale declarations were typechecked against). A merge of main or a branch switch rewrites the
// sources those timestamps describe, so the cache is dropped whenever HEAD or the merge-base moved.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspaceProjects } from "./tsconfig-references.ts";

/** Where the last build in this worktree stood; absolute commits, not times, so a merge shows up. */
export interface TscCacheState {
  head: string;
  base: string;
}

const STATE = join(".cache", "tsc-cache-state.json");

export function readTscCacheState(worktree: string): TscCacheState | undefined {
  let text: string;
  try {
    text = readFileSync(join(worktree, STATE), "utf8");
  } catch {
    // No recorded build in this worktree: nothing to compare against, so nothing to invalidate.
    return undefined;
  }
  let parsed: Partial<TscCacheState>;
  try {
    parsed = JSON.parse(text) as Partial<TscCacheState>;
  } catch {
    // A half-written state file is the same as none: the next build records it again.
    return undefined;
  }
  return typeof parsed.head === "string" && typeof parsed.base === "string"
    ? { head: parsed.head, base: parsed.base }
    : undefined;
}

export function writeTscCacheState(worktree: string, state: TscCacheState) {
  mkdirSync(join(worktree, ".cache"), { recursive: true });
  writeFileSync(join(worktree, STATE), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Drops the incremental declaration output of every workspace package. Only what a build asks for
 * is rebuilt afterwards, so clearing a package the run never visits costs nothing; clearing a
 * subset would instead leave a stale declaration of a dependency in place.
 */
export function clearTscCache(worktree: string) {
  const projects = loadWorkspaceProjects(worktree);
  for (const project of projects)
    rmSync(join(project.root, ".cache", "tsc"), { recursive: true, force: true });
  return projects.length;
}
