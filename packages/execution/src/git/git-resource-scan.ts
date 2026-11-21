import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { checkedRoot, within } from "../core/paths.ts";
import {
  gitResourceIdentity,
  gitResourceParent,
  readGitResource,
  rethrowGitInspectionBug,
  sameGitIdentity,
} from "./git-resource-identity.ts";
import { createGitRepositoryInspection } from "./git-resource-repositories.ts";
import type {
  GitResource,
  GitResourceInspectionInput,
  GitResourceKind,
  GitResourceLimits,
  GitResourceReason,
  GitResourceScope,
  GitResourceSnapshot,
} from "./git-resource-types.ts";
import { createGitResourceWalker } from "./git-resource-walk.ts";

export const GIT_RESOURCE_LIMITS: Readonly<GitResourceLimits> = Object.freeze({
  maxEntries: 10_000,
  maxDepth: 16,
  maxRepositories: 64,
  timeoutMs: 2_000,
  maxFileBytes: 65_536,
});

export function createGitResourceScan(input: GitResourceInspectionInput, signal: AbortSignal) {
  const limits = Object.fromEntries(
    Object.entries(GIT_RESOURCE_LIMITS).map(([key, ceiling]) => {
      const requested = input.limits?.[key as keyof GitResourceLimits];
      if (input.targetsOnly && (key === "maxDepth" || key === "maxEntries")) return [key, 0];
      return [
        key,
        Number.isInteger(requested) && (requested as number) >= 0
          ? Math.min(requested as number, ceiling)
          : ceiling,
      ];
    }),
  ) as unknown as GitResourceLimits;
  const deadline = performance.now() + limits.timeoutMs;
  const resources = new Map<string, GitResource>();
  const repositories: GitResourceSnapshot["repositories"] = [];
  const unresolved: GitResourceSnapshot["coverage"]["unresolved"] = [];
  const knownRoots: string[] = [];
  const limitsReached = new Set<GitResourceReason>();
  const verifiedWrite: string[] = [];
  const verifiedReadOnly: string[] = [];
  const verifiedRegistered: string[] = [];
  const blocked: string[] = [];
  let bytes = 0;
  function issue(path: string, reason: GitResourceReason) {
    if (reason.endsWith("_limit")) limitsReached.add(reason);
    if (unresolved.some((item) => item.path === path && item.reason === reason)) return;
    if (unresolved.length < 128) unresolved.push({ path, reason });
    else limitsReached.add("issue_limit");
  }
  function active(path: string) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) {
      issue(path, "time_limit");
      return false;
    }
    return true;
  }
  const scope = (path: string): GitResourceScope => {
    if (
      blocked.some((root) => within(root, path)) ||
      input.protectedRoots?.some((root) => within(root, path))
    )
      return "protected";
    for (const location of input.trustedGitLocations ?? [])
      if (location.kind !== "metadata" && within(location.path, path)) return location.kind;
    if (verifiedReadOnly.some((root) => within(root, path))) return "readonly";
    if (verifiedWrite.some((root) => within(root, path))) return "write";
    if (verifiedRegistered.some((root) => within(root, path))) return "registered";
    return "outside";
  };
  const readable = (path: string) => ["write", "readonly", "registered"].includes(scope(path));
  async function resource(path: string, kind: GitResourceKind, content = false) {
    if (!active(path)) return undefined;
    const id = `${kind}:${path}`;
    const previous = resources.get(id);
    if (previous) return previous;
    if (resources.size >= 4096) {
      issue(path, "entry_limit");
      return undefined;
    }
    try {
      const identity = await gitResourceIdentity(path);
      const value: GitResource = {
        id,
        kind,
        path,
        scope: scope(path),
        exists: !!identity,
        ...(identity ? { identity } : { parentIdentity: await gitResourceParent(path) }),
      };
      resources.set(id, value);
      if (identity?.type === "symlink") issue(path, "alias");
      if (content && identity && readable(path)) {
        if (!active(path)) return value;
        bytes += Number(identity.size);
        if (bytes > limits.maxFileBytes * 16) {
          issue(path, "file_limit");
          return value;
        }
        const read = await readGitResource(path, limits.maxFileBytes, signal);
        if (read.reason) issue(path, read.reason);
        if (!sameGitIdentity(identity, await gitResourceIdentity(path)))
          issue(path, "changed_during_read");
        else if (read.hash) value.hash = read.hash;
        if (kind === "config" && /^\s*\[\s*include(?:if\b[^\]]*)?\s*\]/im.test(read.text ?? ""))
          issue(path, "config_includes_unknown");
      }
      return value;
    } catch (error) {
      signal.throwIfAborted();
      rethrowGitInspectionBug(error);
      issue(path, "unreadable");
      return undefined;
    }
  }
  async function pointer(path: string, gitfile: boolean) {
    const value = await resource(path, gitfile ? "git-marker" : "pointer");
    if (!value?.exists) return undefined;
    if (!readable(path)) {
      issue(path, "outside_scope");
      return undefined;
    }
    try {
      if (!active(path)) return undefined;
      const read = await readGitResource(path, Math.min(limits.maxFileBytes, 4096), signal);
      if (read.reason) {
        issue(path, read.reason);
        return undefined;
      }
      if (!sameGitIdentity(value.identity, await gitResourceIdentity(path))) {
        issue(path, "changed_during_read");
        return undefined;
      }
      value.hash = read.hash;
      const match = gitfile
        ? /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(read.text ?? "")
        : /^([^\0\r\n]+)\r?\n?$/.exec(read.text ?? "");
      if (!match?.[1]) {
        issue(path, "unsupported_layout");
        return undefined;
      }
      const target = resolve(dirname(path), match[1]);
      if ((await realpath(dirname(target))) !== dirname(target)) {
        issue(target, "alias");
        return undefined;
      }
      return target;
    } catch (error) {
      signal.throwIfAborted();
      rethrowGitInspectionBug(error);
      issue(path, "unreadable");
      return undefined;
    }
  }
  const repository = createGitRepositoryInspection({
    resource,
    pointer,
    readable,
    active,
    scope,
    issue,
    repositories,
    maxRepositories: limits.maxRepositories,
  });
  const scan = createGitResourceWalker({
    resource,
    pointer,
    repository,
    active,
    readable,
    issue,
    limits,
  });
  async function verifyRoot(
    root: { path: string; device?: string; inode?: string },
    destination: string[],
  ) {
    if (!active(root.path)) return;
    try {
      await checkedRoot(root.path);
      const identity = await gitResourceIdentity(root.path);
      if (
        identity?.type !== "directory" ||
        (root.device !== undefined && root.device !== identity.device) ||
        (root.inode !== undefined && root.inode !== identity.inode)
      ) {
        blocked.push(root.path);
        await resource(root.path, "root");
        issue(root.path, "changed_during_read");
        return;
      }
      destination.push(root.path);
      await resource(root.path, "root");
    } catch (error) {
      signal.throwIfAborted();
      rethrowGitInspectionBug(error);
      blocked.push(root.path);
      await resource(root.path, "root");
      issue(root.path, "unreadable");
    }
  }
  async function run() {
    for (const location of input.trustedGitLocations ?? []) {
      if (location.kind === "metadata") await verifyRoot(location, verifiedRegistered);
      else
        await resource(
          location.path,
          location.kind === "global" ? "global-config" : "system-config",
        );
    }
    for (const root of input.readOnlyRoots ?? []) await verifyRoot(root, verifiedReadOnly);
    for (const root of input.writeRoots) await verifyRoot(root, verifiedWrite);
    for (const path of [...verifiedReadOnly, ...verifiedWrite]) {
      if (!active(path)) break;
      knownRoots.push(path);
      if (!input.targetsOnly) await scan(path, 0);
    }
    for (const path of verifiedRegistered) await repository(undefined, path, "metadata");
    for (const path of input.targets ?? []) {
      const value = await resource(path, "fresh-target");
      if (!readable(path)) {
        issue(path, "outside_scope");
        continue;
      }
      if (value?.exists && value.identity?.type === "directory") await scan(path, 0);
      else if (value && !value.exists) {
        if (repositories.length >= limits.maxRepositories) {
          issue(path, "repository_limit");
          continue;
        }
        repositories.push({
          kind: "fresh",
          scope: value.scope,
          worktree: path,
          resourceIds: [value.id],
        });
      }
    }
    signal.throwIfAborted();
    for (const value of resources.values()) {
      value.scope = scope(value.path);
      if (value.kind !== "root") continue;
      try {
        if (!sameGitIdentity(value.identity, await gitResourceIdentity(value.path)))
          issue(value.path, "changed_during_read");
      } catch (error) {
        signal.throwIfAborted();
        rethrowGitInspectionBug(error);
        issue(value.path, "unreadable");
      }
    }
    active(input.cwd);
    return {
      resources: [...resources.values()].sort((a, b) => a.id.localeCompare(b.id)),
      repositories: repositories.sort((a, b) =>
        (a.worktree ?? a.gitDir ?? "").localeCompare(b.worktree ?? b.gitDir ?? ""),
      ),
      coverage: {
        state:
          input.targetsOnly || unresolved.length || limitsReached.size
            ? ("incomplete" as const)
            : ("complete" as const),
        knownRoots: [...new Set(knownRoots)].sort(),
        knownLayouts: [...new Set(repositories.map((repo) => repo.kind))].sort(),
        unresolved: unresolved.sort(
          (a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason),
        ),
        limitsReached: [...limitsReached].sort(),
        futureLayoutProtection: "none" as const,
      },
    };
  }
  return { run };
}
