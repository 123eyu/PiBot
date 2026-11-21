import { join } from "node:path";
import { checkedRoot, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import type { GitConfigurationCandidateInput } from "./git-config-candidate.ts";
import type { GitConfigurationFacts } from "./git-config-facts.ts";
import { gitConfigurationDigest } from "./git-config-intent.ts";
import {
  managedBranchConfigurationIntent,
  verifyRegisteredBranchConfiguration,
} from "./git-config-managed-plan.ts";
import { editGitConfigurationCopy } from "./git-config-publish-copy.ts";
import { configurationReadSync } from "./git-config-publish-io.ts";
import type { GitPublicationPlan } from "./git-config-publish-types.ts";
import { readGitResource, sameGitIdentity } from "./git-resource-identity.ts";

export async function registeredBranchPublicationPlan(
  input: GitConfigurationCandidateInput,
  signal: AbortSignal,
): Promise<GitPublicationPlan> {
  const plan = input.registeredBranch;
  const intent = input.parsed.intent;
  if (
    !plan ||
    !intent ||
    input.process.platform !== "darwin" ||
    process.platform !== "darwin" ||
    intent.cwd !== plan.primary.path ||
    intent.digest !== plan.intentDigest ||
    !managedBranchConfigurationIntent(intent, plan.branch)
  )
    throw new ExecError("invalid_input");
  await verifyWorkspace(input.rootIdentities, signal);
  const path = join(plan.common.path, "config");
  if (
    !input.writeRoots.includes(plan.primary.path) ||
    !input.rootIdentities.some(
      (root) =>
        root.role === "primary" &&
        root.canonicalPath === plan.primary.path &&
        root.device === plan.primary.device &&
        root.inode === plan.primary.inode,
    ) ||
    input.denyWriteRoots.some((root) => within(root, path) || within(path, root))
  )
    throw new ExecError("outside_workplace");
  verifyRegisteredBranchConfiguration(plan);
  const current = configurationReadSync(path);
  if (!sameGitIdentity(plan.config.identity, current.identity) || current.hash !== plan.config.hash)
    throw new ExecError("file_conflict");
  return {
    intent,
    targetPath: path,
    expectedIdentity: plan.config.identity,
    expectedHash: plan.config.hash,
    directories: [plan.source, plan.primary, plan.git, plan.common],
    absentPaths: plan.absentPaths,
    registeredBranch: plan,
  };
}

export async function prepareManagedBranchCandidate(
  input: GitConfigurationCandidateInput,
  signal: AbortSignal,
): Promise<GitConfigurationFacts> {
  const plan = await registeredBranchPublicationPlan(input, signal);
  const registered = input.registeredBranch;
  if (!registered) throw new ExecError("invalid_input");
  const before = await readGitResource(plan.targetPath, 65_536, signal);
  if (before.text === undefined || before.hash !== registered.config.hash)
    throw new ExecError("file_conflict");
  const temp = await checkedRoot(input.privateTempRoot);
  if (input.writeRoots.some((root) => within(root, temp)) || within(registered.common.path, temp))
    throw new ExecError("outside_workplace");
  const bytes = await editGitConfigurationCopy(
    {
      intent: plan.intent,
      text: before.text,
      privateTempRoot: temp,
      process: input.process,
      managedBranch: registered.branch,
    },
    signal,
  );
  await registeredBranchPublicationPlan(input, signal);
  return {
    version: 1,
    status: "candidate",
    scope: "project",
    reason: "managed_branch_candidate",
    requestedKey: plan.intent.key,
    intentDigest: plan.intent.digest,
    targetPath: plan.targetPath,
    beforeVersion: registered.beforeVersion,
    candidateDigest: gitConfigurationDigest(bytes.toString("base64")),
    changedKeys: [plan.intent.key],
    authority: "none",
  };
}
