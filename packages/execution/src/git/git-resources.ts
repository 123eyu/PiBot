import { isAbsolute, resolve } from "node:path";
import { sameGitIdentity } from "./git-resource-identity.ts";
import { createGitResourceScan, GIT_RESOURCE_LIMITS } from "./git-resource-scan.ts";
import type { GitResourceInspectionInput, GitResourceSnapshot } from "./git-resource-types.ts";

export type * from "./git-resource-types.ts";
export { GIT_RESOURCE_LIMITS };

function normalized(input: GitResourceInspectionInput): GitResourceInspectionInput | undefined {
  const roots = [...input.writeRoots, ...(input.readOnlyRoots ?? [])];
  const locations = input.trustedGitLocations ?? [];
  const badPath = (path: string) => !path || path.length > 4096 || path.includes("\0");
  if (
    (input.targetsOnly !== undefined && input.targetsOnly !== true) ||
    badPath(input.cwd) ||
    (input.protectedRoots?.length ?? 0) > 256 ||
    (input.targets ?? []).some(badPath) ||
    Object.values(input.limits ?? {}).some((value) => !Number.isInteger(value) || value < 0)
  )
    return undefined;
  if (
    !isAbsolute(input.cwd) ||
    roots.length === 0 ||
    roots.length > 32 ||
    locations.length > 64 ||
    (input.targets?.length ?? 0) > 64 ||
    [
      ...roots.map((root) => root.path),
      ...locations.map((item) => item.path),
      ...(input.protectedRoots ?? []),
    ].some((path) => !isAbsolute(path) || badPath(path))
  )
    return undefined;
  return {
    ...(input.targetsOnly ? { targetsOnly: true } : {}),
    cwd: resolve(input.cwd),
    writeRoots: input.writeRoots.map((root) => ({ ...root, path: resolve(root.path) })),
    readOnlyRoots: (input.readOnlyRoots ?? []).map((root) => ({
      ...root,
      path: resolve(root.path),
    })),
    trustedGitLocations: locations.map((location) => ({
      ...location,
      path: resolve(location.path),
    })),
    targets: (input.targets ?? []).map((path) => resolve(input.cwd, path)),
    protectedRoots: (input.protectedRoots ?? []).map((path) => resolve(path)),
    limits: Object.fromEntries(
      Object.entries(input.limits ?? {}).map(([key, value]) => [
        key,
        Math.min(value, GIT_RESOURCE_LIMITS[key as keyof typeof GIT_RESOURCE_LIMITS]),
      ]),
    ),
  };
}

/** Complete describes the known scan only; this diagnostic grants no filesystem capability. */
export async function inspectGitResources(
  input: GitResourceInspectionInput,
  signal: AbortSignal,
): Promise<GitResourceSnapshot> {
  signal.throwIfAborted();
  const saved = normalized(input);
  const platform = ["darwin", "linux", "win32"].includes(process.platform)
    ? (process.platform as "darwin" | "linux" | "win32")
    : "other";
  const platformCapabilities: GitResourceSnapshot["platformCapabilities"] = {
    platform,
    inspection: "read-only",
    commandIsolation: platform === "win32" ? "windows-unisolated" : "not-evaluated",
    authority: "none",
  };
  if (!saved)
    return {
      version: 1,
      input: { cwd: input.cwd, writeRoots: [] },
      resources: [],
      repositories: [],
      platformCapabilities,
      coverage: {
        state: "incomplete",
        knownRoots: [],
        knownLayouts: [],
        unresolved: [{ path: input.cwd, reason: "invalid_input" }],
        limitsReached: [],
        futureLayoutProtection: "none",
      },
    };
  const facts = await createGitResourceScan(saved, signal).run();
  return { version: 1, input: saved, ...facts, platformCapabilities };
}

/** A failed repeat cannot prove stability, even if the original scan was already incomplete. */
export async function revalidateGitResources(
  snapshot: GitResourceSnapshot,
  signal: AbortSignal,
): Promise<"unchanged" | "changed" | "incomplete"> {
  const current = await inspectGitResources(snapshot.input, signal);
  const byId = new Map(current.resources.map((item) => [item.id, item]));
  for (const previous of snapshot.resources) {
    const next = byId.get(previous.id);
    if (!next) continue;
    if (
      previous.exists !== next.exists ||
      !sameGitIdentity(previous.identity, next.identity) ||
      !sameGitIdentity(previous.parentIdentity, next.parentIdentity) ||
      (previous.hash !== undefined && next.hash !== undefined && previous.hash !== next.hash)
    )
      return "changed";
  }
  if (current.coverage.state === "incomplete" || snapshot.coverage.state === "incomplete")
    return "incomplete";
  return JSON.stringify(current) === JSON.stringify(snapshot) ? "unchanged" : "changed";
}
