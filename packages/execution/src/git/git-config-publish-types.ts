import type { FileHandle } from "node:fs/promises";
import type { GitConfigurationCandidateInput } from "./git-config-candidate.ts";
import type { GitConfigurationFacts } from "./git-config-facts.ts";
import type { GitConfigurationIntent } from "./git-config-intent.ts";
import type { GitUpstreamSnapshot } from "./git-config-upstream.ts";
import type { GitResourceIdentity } from "./git-resource-types.ts";

export interface GitConfigurationCallRequirement {
  scope: "project" | "global";
  key: string;
  changedKeys: readonly string[];
  targetPath: string;
  intentDigest: string;
  beforeVersion: string;
  explicitConfirmationRequired: boolean;
}
export interface GitConfigurationPublishInput extends GitConfigurationCandidateInput {
  target: "local";
  preparedFacts: GitConfigurationFacts;
  /** Trusted synchronous current-call assertion. Global calls must prove that person's one-call consent. */
  assertCurrentCall(requirement: Readonly<GitConfigurationCallRequirement>): void;
}
export interface GitConfigurationPublishReceipt {
  status: "applied";
  scope: "project" | "global";
  key: string;
  changedKeys: string[];
  targetPath: string;
  intentDigest: string;
  beforeVersion: string;
  publishedHash: string;
  bytes: number;
  cancelledAfterPublication: boolean;
  durability: "synced" | "unconfirmed";
  cleanup: "complete" | "required";
  warnings: ("directory_sync_failed" | "handle_close_failed" | "rename_reported_error")[];
}
export interface GitPublicationDirectory {
  path: string;
  device: string;
  inode: string;
  handle: FileHandle;
}
export interface GitPublicationPlan {
  intent: GitConfigurationIntent;
  targetPath: string;
  directories: { path: string; device: string; inode: string }[];
  expectedIdentity?: GitResourceIdentity;
  expectedHash?: string;
  absentPaths: string[];
  registeredBranch?: import("./git-config-managed-plan.ts").RegisteredBranchConfigurationPlan;
  upstream?: GitUpstreamSnapshot;
}
