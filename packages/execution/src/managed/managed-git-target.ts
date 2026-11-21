import type { ManagedPathIdentity } from "./managed-boundary.ts";
import type { ManagedGitAuthority, ManagedGitRepository, ManagedGitWrite } from "./managed-git.ts";

/** One file a reviewed commit would take; `deleted` paths carry no content to check. */
export interface ManagedCommitFile {
  path: string;
  size: number;
  sha256: string;
  deleted: boolean;
}

/**
 * Managed Git on another machine. Group worktree code uses the local ManagedGit for
 * the desktop and this for a runner. Paths are the runner's own; write results carry what only
 * the runner could observe (the `.pibot/wt` folder it prepared on create).
 */
export interface RemoteManagedGit {
  inspect(path: string, signal: AbortSignal): Promise<ManagedGitRepository>;
  ancestor(cwd: string, a: string, b: string, signal: AbortSignal): Promise<boolean>;
  ownsLock(cwd: string, path: string, managedId: string, signal: AbortSignal): Promise<boolean>;
  write(
    operation: ManagedGitWrite,
    authority: ManagedGitAuthority,
  ): Promise<{ parent?: ManagedPathIdentity; integrated?: boolean }>;
  /**
   * The runner lists what it would commit, `review` checks every file here (sensitive paths,
   * redactor), and the runner commits exactly that list or refuses if it changed meanwhile.
   */
  commitReviewed(
    repository: ManagedGitRepository,
    commit: { name: string; email: string; message: string },
    review: (files: ManagedCommitFile[], signal: AbortSignal) => Promise<void>,
    authority: ManagedGitAuthority,
  ): Promise<ManagedGitRepository>;
}
