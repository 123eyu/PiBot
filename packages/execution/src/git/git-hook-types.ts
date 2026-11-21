import type { RunCommandOptions } from "../core/types.ts";
import type { LinuxGitHookShell } from "./git-hook-system-shell.ts";
import type { GitResourceIdentity } from "./git-resource-types.ts";

export interface GitHookFacts {
  version: 1;
  status: "unsupported" | "confirmation-required";
  reason:
    | "unsupported_syntax"
    | "unsupported_scope"
    | "unsupported_config"
    | "unsupported_entry"
    | "changed"
    | "once_required";
  authority: "none";
  cwd?: string;
  hookPath?: string;
  hookHash?: string;
  program?: string;
  programHash?: string;
  args?: string[];
  beforeVersion?: string;
}
export interface GitHookSource {
  path: string;
  identity?: GitResourceIdentity;
  parent?: GitResourceIdentity;
  hash?: string;
}
export interface GitHookPlan {
  platform: "darwin" | "linux";
  linuxShell?: LinuxGitHookShell;
  facts: GitHookFacts;
  command: string;
  cwd: string;
  botHome: string;
  gitProgram: string;
  script: string;
  sources: GitHookSource[];
  claimed?: true;
  rootIdentities: NonNullable<RunCommandOptions["rootIdentities"]>;
  writeRoots: readonly string[];
  denyWriteRoots: readonly string[];
}
/** Trusted in-process recipe. It is not a serializable permission or a model argument. */
export interface GitHookExecution {
  plan: GitHookPlan;
  assertCurrentCall(facts: GitHookFacts): void;
}
export interface GitHookPrepareInput {
  command: string;
  cwd: string;
  botHome: string;
  privateTempRoot: string;
  rootIdentities: NonNullable<RunCommandOptions["rootIdentities"]>;
  writeRoots: readonly string[];
  denyWriteRoots: readonly string[];
}
