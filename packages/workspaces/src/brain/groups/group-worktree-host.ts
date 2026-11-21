import { createHash } from "node:crypto";
import path from "node:path";
import type { WorkspaceLocal as LocalService } from "@pibot/brain/kit";
import {
  type createGitReader,
  type ManagedGit,
  type ManagedGitAuthority,
  type ManagedGitRepository,
  type ManagedGitWrite,
  type ManagedPathIdentity,
  managedIdentity,
  prepareManagedProject,
  type RemoteManagedGit,
} from "@pibot/execution";
import { RpcError, type WorkspaceSnapshot } from "@pibot/workspaces-contract/full";
import { commitGroupWorktree, sensitiveOutputPath } from "./group-worktree-commit.ts";

const COMMIT = {
  name: "Pi Bot",
  email: "pibot@localhost",
  message: "chore: integrate group member task outputs\n",
};

/**
 * Where a group's managed worktrees live: this desktop, or the runner its primary folder is
 * on. The flow is the same; only what needs the machine's own disk differs, and on a runner that
 * part is done by the runner itself (it prepares `.pibot/wt` and re-checks identities).
 */
export interface WorktreeHost {
  readonly remote: boolean;
  /** Path rules of the machine the worktrees are on. */
  readonly paths: typeof path.posix;
  inspect(path: string, signal: AbortSignal): Promise<ManagedGitRepository>;
  ancestor(cwd: string, a: string, b: string, signal: AbortSignal): Promise<boolean>;
  /** false: not a Git repository (the group falls back to serial work). */
  isRepository(cwd: string, signal: AbortSignal): Promise<boolean>;
  /** Local: prepares `.pibot/wt` now. Runner: undefined, the runner prepares it on create. */
  project(
    source: ManagedGitRepository,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<ManagedPathIdentity | undefined>;
  /** Local: the folder is unchanged since create. Runner: checked by the runner at remove. */
  parentUnchanged(parentPath: string, expected: ManagedPathIdentity): Promise<boolean>;
  write(
    operation: ManagedGitWrite,
    authority: ManagedGitAuthority,
  ): Promise<{ parent?: ManagedPathIdentity }>;
  commit(
    repository: ManagedGitRepository,
    authority: ManagedGitAuthority,
  ): Promise<ManagedGitRepository>;
}

export function localWorktreeHost(
  local: LocalService,
  git: ManagedGit,
  reader: ReturnType<typeof createGitReader>,
): WorktreeHost {
  return {
    remote: false,
    paths: path,
    inspect: git.inspect,
    ancestor: git.ancestor,
    async isRepository(cwd, signal) {
      const probe = await reader.run({ op: "probe" }, { cwd, signal });
      if (probe.exitCode === 0) return true;
      if (!probe.overflow && probe.stderr.includes("not a git repository")) return false;
      throw new RpcError(-32602, "group_workspace_git_unavailable");
    },
    project: (source, signal, authorize) =>
      prepareManagedProject(source.root, signal, authorize, source.git),
    async parentUnchanged(parentPath, expected) {
      const current = await managedIdentity(parentPath);
      return current.device === expected.device && current.inode === expected.inode;
    },
    async write(operation, authority) {
      await git.write(operation, authority);
      return {};
    },
    async commit(repository, authority) {
      return commitGroupWorktree(local, git, repository, authority);
    },
  };
}

/**
 * The runner's worktrees. Commit review reads each listed file through the workspace file
 * access, checks its digest, the sensitive-path rule and the redactor here on the control side
 * (the secrets table never goes to the runner), and only then lets the runner commit that list.
 */
export function remoteWorktreeHost(local: LocalService, boundary: WorkspaceSnapshot): WorktreeHost {
  const location = boundary.location;
  if (!location || location.target === "local")
    throw new RpcError(-32602, "group_workspace_changed");
  const target = local.targetFor(location);
  const git: RemoteManagedGit | undefined = target.managedGit;
  if (!git) throw new RpcError(-32601, "runner_update_required");
  const paths = location.platform === "win32" ? path.win32 : path.posix;
  const files = local.runtime.files(boundary);
  return {
    remote: true,
    paths,
    inspect: (cwd, signal) => git.inspect(cwd, signal),
    ancestor: (cwd, a, b, signal) => git.ancestor(cwd, a, b, signal),
    async isRepository(cwd, signal) {
      try {
        await git.inspect(cwd, signal);
        return true;
      } catch (error) {
        signal.throwIfAborted();
        // The runner's inspect refuses a folder that is not a repository with this code.
        if (error instanceof RpcError && error.message === "managed_git_layout_unsupported")
          return false;
        throw new RpcError(-32602, "group_workspace_git_unavailable");
      }
    },
    project: async () => undefined,
    parentUnchanged: async () => true,
    write: (operation, authority) => git.write(operation, authority),
    commit(repository, authority) {
      if (repository.clean) return Promise.resolve(repository);
      return git.commitReviewed(
        repository,
        COMMIT,
        async (list, signal) => {
          if (list.length > 500) throw new RpcError(-32602, "group_workspace_commit_unavailable");
          for (const file of list) {
            signal.throwIfAborted();
            if (sensitiveOutputPath(file.path))
              throw new RpcError(-32602, "group_workspace_sensitive_output");
            if (file.deleted) continue;
            const read = await files.read(repository.root.path, file.path, signal, 5 * 1024 * 1024);
            if (!read?.data || createHash("sha256").update(read.data).digest("hex") !== file.sha256)
              throw new RpcError(-32602, "group_workspace_changed");
            const text = read.data.toString("utf8");
            if (local.deps.redactor.redact(text) !== text)
              throw new RpcError(-32602, "group_workspace_sensitive_output");
          }
        },
        authority,
      );
    },
  };
}
