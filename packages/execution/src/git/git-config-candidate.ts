import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { checkedRoot, within } from "../core/paths.ts";
import { ExecError, type RunCommandOptions } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import type { GitConfigurationFacts } from "./git-config-facts.ts";
import {
  hooksPathConfigurationVersion,
  sealHooksPathConfiguration,
} from "./git-config-hooks-path.ts";
import {
  type GitConfigurationIntentResult,
  gitConfigurationArguments,
  gitConfigurationChanges,
  gitConfigurationDigest,
  gitConfigurationIntent,
} from "./git-config-intent.ts";
import {
  type KnownGitConfigurationFile,
  knownConfigurationFileBytes,
  knownConfigurationFileMatches,
} from "./git-config-known-file.ts";
import { prepareManagedBranchCandidate } from "./git-config-managed-candidate.ts";
import type { RegisteredBranchConfigurationPlan } from "./git-config-managed-plan.ts";
import { validateGitUpstreamObjects } from "./git-config-object-view.ts";
import type { GitConfigurationProcessOptions } from "./git-config-process.ts";
import { editGitConfigurationCopy } from "./git-config-publish-copy.ts";
import { globalGitConfigurationMetadata } from "./git-config-publish-target.ts";
import { resolveGitUpstream, verifyGitUpstream } from "./git-config-upstream.ts";
import {
  gitResourceIdentity,
  readGitResource,
  rethrowGitInspectionBug,
  sameGitIdentity,
} from "./git-resource-identity.ts";
import type { GitResourceSnapshot } from "./git-resource-types.ts";

export interface GitConfigurationCandidateInput {
  hooksPath?: import("./git-config-hooks-path.ts").HooksPathConfigurationPlan;
  knownFile?: KnownGitConfigurationFile;
  registeredBranch?: RegisteredBranchConfigurationPlan;
  parsed: GitConfigurationIntentResult;
  snapshot: GitResourceSnapshot;
  rootIdentities: NonNullable<RunCommandOptions["rootIdentities"]>;
  writeRoots: readonly string[];
  denyWriteRoots: readonly string[];
  privateTempRoot: string;
  userHome: string;
  process: GitConfigurationProcessOptions;
}
/** Prepares a disposable candidate; nothing in this API publishes into Git or user configuration. */
async function prepareCandidate(
  input: GitConfigurationCandidateInput,
  request: AbortSignal,
): Promise<GitConfigurationFacts> {
  const signal = AbortSignal.any([request, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const { parsed } = input;
  const intent = parsed.intent;
  const facts: GitConfigurationFacts = {
    version: 1,
    status: parsed.reason === "not_config_setter" ? "not-applicable" : "unsupported",
    reason: parsed.reason,
    ...(parsed.scope ? { scope: parsed.scope } : {}),
    changedKeys: [],
    authority: "none",
    ...(intent ? { requestedKey: intent.key, intentDigest: intent.digest } : {}),
  };
  const empty = () => facts;
  if (!intent) return empty();
  if (
    (intent.key === "core.hookspath") !== !!input.hooksPath ||
    (input.hooksPath && (input.knownFile || input.registeredBranch))
  )
    return empty();
  if (input.process.platform !== process.platform) {
    facts.reason = "scope_unverified";
    return empty();
  }
  const verified = gitConfigurationIntent(
    {
      program: intent.program,
      args: gitConfigurationArguments(intent),
    },
    intent.cwd,
  );
  if (
    !verified.intent ||
    verified.intent.digest !== intent.digest ||
    verified.intent.key !== intent.key ||
    verified.intent.scope !== intent.scope
  ) {
    facts.reason = verified.intent ? "changed" : verified.reason;
    return empty();
  }
  if (input.registeredBranch) return prepareManagedBranchCandidate(input, signal);
  if (intent.scope === "global") {
    // Personal configuration is not read before its own future mandatory confirmation.
    const global = await globalGitConfigurationMetadata(input.userHome, input.process.env);
    facts.status = "confirmation-required";
    facts.targetPath = global.path;
    facts.beforeVersion = global.version;
    facts.changedKeys = [intent.key];
    return empty();
  }
  await verifyWorkspace(input.rootIdentities, signal);
  const repo = input.snapshot.repositories
    .filter(
      (item) => item.kind === "ordinary" && item.worktree && within(item.worktree, intent.cwd),
    )
    .sort((a, b) => (b.worktree?.length ?? 0) - (a.worktree?.length ?? 0))[0];
  if (
    !repo?.worktree ||
    !repo.gitDir ||
    repo.gitDir !== join(repo.worktree, ".git") ||
    repo.commonDir !== repo.gitDir
  ) {
    facts.reason = "shared_metadata";
    return empty();
  }
  const path = join(repo.gitDir, "config");
  const owner = input.writeRoots
    .filter((root) => within(root, path))
    .sort((a, b) => b.length - a.length)[0];
  if (
    !owner ||
    input.denyWriteRoots.some((root) => within(root, path)) ||
    !input.rootIdentities.some(
      (root) => root.canonicalPath === owner && root.role !== "readonly",
    ) ||
    (await realpath(intent.cwd)) !== intent.cwd ||
    (await checkedRoot(repo.gitDir)) !== repo.gitDir
  ) {
    facts.reason = "scope_unverified";
    return empty();
  }
  const expected = input.snapshot.resources.find(
    (item) => item.kind === "config" && item.path === path,
  );
  const identity = await gitResourceIdentity(path);
  if (!expected?.hash || !sameGitIdentity(expected.identity, identity)) {
    facts.reason = "changed";
    return empty();
  }
  const before = await readGitResource(path, 65536, signal);
  if (!before.hash || before.hash !== expected.hash || before.text === undefined) {
    facts.reason = "changed";
    return empty();
  }
  if (createHash("sha256").update(before.text).digest("hex") !== before.hash) {
    facts.reason = "candidate_failed";
    return empty();
  }
  if (/^\s*\[\s*include(?:if\b[^\]]*)?\s*\]/im.test(before.text)) {
    facts.reason = "includes_unknown";
    return empty();
  }
  const tempRoot = await checkedRoot(input.privateTempRoot);
  if (!isAbsolute(tempRoot) || input.writeRoots.some((root) => within(root, tempRoot))) {
    facts.reason = "scope_unverified";
    return empty();
  }
  try {
    const resolved = await resolveGitUpstream(verified.intent, repo.gitDir, signal);
    const proposed = input.knownFile
      ? knownConfigurationFileBytes(input.knownFile, resolved.intent, before.hash)
      : await editGitConfigurationCopy(
          {
            intent: resolved.intent,
            ...(input.hooksPath ? { hooksPath: input.hooksPath } : {}),
            text: before.text,
            privateTempRoot: tempRoot,
            process: input.process,
            ...(resolved.upstream
              ? {
                  objectFormat:
                    resolved.upstream.oids[0]?.length === 64
                      ? ("sha256" as const)
                      : ("sha1" as const),
                }
              : {}),
          },
          signal,
        );
    if (resolved.upstream) {
      await validateGitUpstreamObjects(
        {
          gitDir: repo.gitDir,
          oids: resolved.upstream.oids,
          program: intent.program,
          privateTempRoot: tempRoot,
          process: input.process,
          assertSources: () => verifyGitUpstream(resolved.upstream),
        },
        signal,
      );
      verifyGitUpstream(resolved.upstream);
    }
    await verifyWorkspace(input.rootIdentities, signal);
    if (
      !sameGitIdentity(identity, await gitResourceIdentity(path)) ||
      (await readGitResource(path, 65536, signal)).hash !== before.hash
    ) {
      facts.reason = "changed";
      return empty();
    }
    const sensitive = verified.reason === "sensitive_project_confirmation_required";
    facts.status = sensitive ? "confirmation-required" : "candidate";
    facts.reason = input.hooksPath
      ? "hooks_path_candidate"
      : sensitive
        ? "sensitive_project_confirmation_required"
        : "ordinary_project_candidate";
    facts.targetPath = path;
    facts.beforeVersion = gitConfigurationDigest({
      identity,
      hash: before.hash,
      ...(resolved.upstream ? { upstream: resolved.upstream } : {}),
    });
    facts.candidateDigest = gitConfigurationDigest(proposed.toString("base64"));
    facts.requestedKey = resolved.intent.key;
    if (resolved.upstream) facts.resolvedBranch = resolved.upstream.branch;
    facts.changedKeys = gitConfigurationChanges(resolved.intent).map((change) => change.key);
    if (input.hooksPath) {
      facts.operation = "hooks-path";
      facts.hooksPathVersion = hooksPathConfigurationVersion(input.hooksPath);
      sealHooksPathConfiguration(input.hooksPath, facts, signal);
    }
    if (input.knownFile) {
      facts.operation = "known-file";
      if (!knownConfigurationFileMatches(input.knownFile, facts))
        throw new ExecError("authorization_changed");
    }
    return facts;
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ExecError) || error.reason === "cleanup_failed") throw error;
    if (error.code === "git_unavailable") {
      facts.reason = "unsupported_program";
      return empty();
    }
    facts.reason = "candidate_failed";
    return empty();
  }
}

export async function prepareGitConfigurationCandidate(
  input: GitConfigurationCandidateInput,
  signal: AbortSignal,
): Promise<GitConfigurationFacts> {
  try {
    return await prepareCandidate(input, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ExecError && error.reason === "cleanup_failed") throw error;
    if (error instanceof Error && error.name === "TimeoutError")
      return {
        version: 1,
        status: "unsupported",
        reason: "candidate_failed",
        changedKeys: [],
        authority: "none",
      };
    rethrowGitInspectionBug(error);
    return {
      version: 1,
      status: "unsupported",
      reason: "scope_unverified",
      changedKeys: [],
      authority: "none",
    };
  }
}
