import type { GitConfigurationReason } from "./git-config-intent.ts";
export interface GitConfigurationFacts {
  version: 1;
  operation?: "known-file" | "hooks-path";
  hooksPathVersion?: string;
  status: "not-applicable" | "unsupported" | "candidate" | "confirmation-required";
  scope?: "project" | "global" | "system";
  reason: GitConfigurationReason;
  requestedKey?: string;
  resolvedBranch?: string;
  intentDigest?: string;
  targetPath?: string;
  beforeVersion?: string;
  candidateDigest?: string;
  changedKeys: string[];
  authority: "none";
}
