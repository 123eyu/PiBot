import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { rethrowGitInspectionBug } from "./git-resource-identity.ts";
import type {
  GitResource,
  GitResourceKind,
  GitResourceReason,
  GitResourceScope,
  GitResourceSnapshot,
} from "./git-resource-types.ts";

type Repository = GitResourceSnapshot["repositories"][number];
interface RepositoryInspection {
  resource(
    path: string,
    kind: GitResourceKind,
    content?: boolean,
  ): Promise<GitResource | undefined>;
  pointer(path: string, gitfile: boolean): Promise<string | undefined>;
  readable(path: string): boolean;
  active(path: string): boolean;
  scope(path: string): GitResourceScope;
  issue(path: string, reason: GitResourceReason): void;
  repositories: Repository[];
  maxRepositories: number;
}
export function createGitRepositoryInspection(input: RepositoryInspection) {
  const { resource, pointer, readable, active, scope, issue, repositories, maxRepositories } =
    input;
  const repoKeys = new Set<string>();
  async function repository(
    worktree: string | undefined,
    gitDir: string,
    kind: GitResourceSnapshot["repositories"][number]["kind"],
  ) {
    const key = `${worktree ?? ""}:${gitDir}`;
    if (repoKeys.has(key) || !active(gitDir)) return;
    if (repositories.length >= maxRepositories) {
      issue(gitDir, "repository_limit");
      return;
    }
    repoKeys.add(key);
    const directory = await resource(gitDir, "git-directory");
    const ids = directory ? [directory.id] : [];
    const repo: GitResourceSnapshot["repositories"][number] = {
      kind,
      scope: scope(gitDir),
      ...(worktree ? { worktree } : {}),
      gitDir,
      resourceIds: ids,
    };
    repositories.push(repo);
    if (!readable(gitDir)) {
      issue(gitDir, "outside_scope");
      return;
    }
    if (directory?.identity?.type !== "directory") {
      issue(gitDir, "unsupported_layout");
      return;
    }
    try {
      if ((await realpath(gitDir)) !== gitDir) {
        issue(gitDir, "alias");
        return;
      }
    } catch (error) {
      if (!active(gitDir)) return;
      rethrowGitInspectionBug(error);
      issue(gitDir, "unreadable");
      return;
    }
    const commonPointer = await resource(join(gitDir, "commondir"), "pointer");
    const commonDir = commonPointer?.exists
      ? await pointer(join(gitDir, "commondir"), false)
      : gitDir;
    if (!commonDir) return;
    repo.commonDir = commonDir;
    if (commonPointer?.exists) {
      repo.kind = "worktree";
      ids.push(commonPointer.id);
    }
    const common = await resource(commonDir, "common-directory");
    if (common) ids.push(common.id);
    if (!readable(commonDir)) {
      issue(commonDir, "outside_scope");
      return;
    }
    if (common?.identity?.type !== "directory") {
      issue(commonDir, "unsupported_layout");
      return;
    }
    for (const [parent, name, itemKind] of [
      [gitDir, "HEAD", "head"],
      [gitDir, "index", "index"],
      [gitDir, "config.worktree", "config"],
      [commonDir, "config", "config"],
      [commonDir, "hooks", "hooks"],
      [commonDir, "objects", "objects"],
      [commonDir, "refs", "refs"],
    ] as const) {
      const path = join(parent, name);
      const item = await resource(path, itemKind, itemKind === "config" || itemKind === "head");
      if (item) ids.push(item.id);
    }
  }

  return repository;
}
