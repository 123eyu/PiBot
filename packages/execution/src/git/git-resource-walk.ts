import { opendir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { gitResourceIdentity, rethrowGitInspectionBug } from "./git-resource-identity.ts";
import type {
  GitResource,
  GitResourceKind,
  GitResourceLimits,
  GitResourceReason,
  GitResourceSnapshot,
} from "./git-resource-types.ts";

interface WalkerInput {
  resource(
    path: string,
    kind: GitResourceKind,
    content?: boolean,
  ): Promise<GitResource | undefined>;
  pointer(path: string, gitfile: boolean): Promise<string | undefined>;
  repository(
    worktree: string | undefined,
    gitDir: string,
    kind: GitResourceSnapshot["repositories"][number]["kind"],
  ): Promise<void>;
  active(path: string): boolean;
  readable(path: string): boolean;
  issue(path: string, reason: GitResourceReason): void;
  limits: GitResourceLimits;
}
const sensitiveNames = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".pi",
  ".docker",
  ".kube",
  ".git-credentials",
]);
export function createGitResourceWalker(input: WalkerInput) {
  const { resource, pointer, repository, active, readable, issue, limits } = input;
  const visited = new Set<string>();
  let entries = 0;
  async function scan(path: string, depth: number) {
    if (!active(path) || visited.has(path)) return;
    if (!readable(path)) {
      issue(path, "outside_scope");
      return;
    }
    if (depth > limits.maxDepth) {
      issue(path, "depth_limit");
      return;
    }
    visited.add(path);
    try {
      const identity = await gitResourceIdentity(path);
      if (identity?.type !== "directory" || (await realpath(path)) !== path) {
        issue(path, "alias");
        return;
      }
      const marker = await gitResourceIdentity(join(path, ".git"));
      if (marker) {
        await resource(join(path, ".git"), "git-marker", false);
        if (marker.type === "directory") await repository(path, join(path, ".git"), "ordinary");
        else if (marker.type === "file") {
          const target = await pointer(join(path, ".git"), true);
          if (target)
            await repository(
              path,
              target,
              target.includes(`${sep}.git${sep}modules${sep}`) ? "submodule" : "gitfile",
            );
        } else issue(join(path, ".git"), "alias");
      }
      const head = await gitResourceIdentity(join(path, "HEAD"));
      if (
        head?.type === "file" &&
        (await gitResourceIdentity(join(path, "objects")))?.type === "directory" &&
        (await gitResourceIdentity(join(path, "refs")))?.type === "directory"
      ) {
        await repository(undefined, path, "bare");
        return;
      }
      const dir = await opendir(path, { bufferSize: 16 });
      for await (const entry of dir) {
        if (!active(path)) return;
        if (++entries > limits.maxEntries) {
          issue(path, "entry_limit");
          return;
        }
        if (entry.name === ".git") continue;
        const child = join(path, entry.name);
        if (sensitiveNames.has(entry.name) || [".gitconfig", "credentials"].includes(entry.name)) {
          issue(child, "protected");
          continue;
        }
        if (entry.name === ".gitmodules") await resource(child, "manifest", true);
        if (entry.isSymbolicLink()) {
          issue(child, "alias");
          continue;
        }
        if (entry.isDirectory()) await scan(child, depth + 1);
      }
    } catch (error) {
      if (!active(path)) return;
      rethrowGitInspectionBug(error);
      issue(path, "unreadable");
    }
  }
  return scan;
}
