export interface GitResourceRoot {
  path: string;
  device?: string;
  inode?: string;
}
export interface GitResourceLimits {
  maxEntries: number;
  maxDepth: number;
  maxRepositories: number;
  timeoutMs: number;
  maxFileBytes: number;
}
export interface GitResourceInspectionInput {
  /** Diagnose explicit layouts only; no implicit root or descendant discovery. */
  targetsOnly?: true;
  cwd: string;
  writeRoots: readonly GitResourceRoot[];
  readOnlyRoots?: readonly GitResourceRoot[];
  targets?: readonly string[];
  /** Only the caller's already registered metadata is readable outside workplace roots. */
  trustedGitLocations?: readonly {
    path: string;
    kind: "metadata" | "global" | "system";
  }[];
  protectedRoots?: readonly string[];
  /** Overrides can lower, but never raise, the inspection budget. */
  limits?: Partial<GitResourceLimits>;
}
export type GitResourceScope =
  | "write"
  | "readonly"
  | "registered"
  | "global"
  | "system"
  | "outside"
  | "protected";
export type GitResourceKind =
  | "root"
  | "git-marker"
  | "git-directory"
  | "common-directory"
  | "pointer"
  | "config"
  | "manifest"
  | "hooks"
  | "objects"
  | "index"
  | "refs"
  | "head"
  | "fresh-target"
  | "global-config"
  | "system-config";
export interface GitResourceIdentity {
  path: string;
  device: string;
  inode: string;
  size: string;
  modifiedNs: string;
  changedNs: string;
  links: string;
  type: "directory" | "file" | "symlink" | "other";
}
export interface GitResource {
  id: string;
  kind: GitResourceKind;
  scope: GitResourceScope;
  path: string;
  exists: boolean;
  identity?: GitResourceIdentity;
  parentIdentity?: GitResourceIdentity;
  hash?: string;
}
export type GitResourceReason =
  | "invalid_input"
  | "outside_scope"
  | "protected"
  | "unreadable"
  | "alias"
  | "hardlink"
  | "changed_during_read"
  | "unsupported_layout"
  | "config_includes_unknown"
  | "entry_limit"
  | "depth_limit"
  | "repository_limit"
  | "time_limit"
  | "file_limit"
  | "issue_limit";
export interface GitResourceSnapshot {
  version: 1;
  /** Saved inputs repeat this diagnostic, not a transferable approval. */
  input: GitResourceInspectionInput;
  coverage: {
    state: "complete" | "incomplete";
    knownRoots: string[];
    knownLayouts: string[];
    unresolved: { path: string; reason: GitResourceReason }[];
    limitsReached: GitResourceReason[];
    futureLayoutProtection: "none";
  };
  repositories: {
    kind: "ordinary" | "gitfile" | "worktree" | "submodule" | "bare" | "fresh" | "metadata";
    scope: GitResourceScope;
    worktree?: string;
    gitDir?: string;
    commonDir?: string;
    resourceIds: string[];
  }[];
  resources: GitResource[];
  platformCapabilities: {
    platform: "darwin" | "linux" | "win32" | "other";
    inspection: "read-only";
    commandIsolation: "not-evaluated" | "windows-unisolated";
    authority: "none";
  };
}
