import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { checkedRoot, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import {
  assertHooksPathPublication,
  hooksPathConfigurationDirectories,
} from "./git-config-hooks-path.ts";
import {
  gitConfigurationArguments,
  gitConfigurationChanges,
  gitConfigurationDigest,
  gitConfigurationIntent,
} from "./git-config-intent.ts";
import { knownConfigurationFileMatches } from "./git-config-known-file.ts";
import { registeredBranchPublicationPlan } from "./git-config-managed-candidate.ts";
import type {
  GitConfigurationPublishInput,
  GitPublicationPlan,
} from "./git-config-publish-types.ts";
import { resolveGitUpstream } from "./git-config-upstream.ts";
import { gitResourceIdentity } from "./git-resource-identity.ts";
import type { GitResourceIdentity } from "./git-resource-types.ts";

export const directoryKey = (identity: GitResourceIdentity) => ({
  path: identity.path,
  device: identity.device,
  inode: identity.inode,
  type: identity.type,
});
export async function globalGitConfigurationMetadata(
  userHome: string,
  env: Readonly<NodeJS.ProcessEnv>,
) {
  const home = await checkedRoot(userHome);
  if (dirname(home) === home) throw new ExecError("outside_workplace");
  const homeIdentity = await gitResourceIdentity(home);
  const legacy = join(home, ".gitconfig"),
    xdg = env.XDG_CONFIG_HOME;
  if (xdg && (!isAbsolute(xdg) || /[\0\r\n]/.test(xdg))) throw new ExecError("outside_workplace");
  const alternative = xdg ? join(xdg, "git", "config") : join(home, ".config", "git", "config");
  const legacyIdentity = await gitResourceIdentity(legacy);
  if (!legacyIdentity && !within(home, alternative)) throw new ExecError("outside_workplace");
  const alternativeIdentity = legacyIdentity ? undefined : await gitResourceIdentity(alternative);
  const path = legacyIdentity || !alternativeIdentity ? legacy : alternative;
  const absentPaths = path === legacy ? (!legacyIdentity ? [alternative] : []) : [legacy];
  const parent = await gitResourceIdentity(dirname(path)),
    identity = await gitResourceIdentity(path);
  if (
    !homeIdentity ||
    parent?.type !== "directory" ||
    (await realpath(dirname(path))) !== dirname(path) ||
    (identity && (identity.type !== "file" || identity.links !== "1"))
  )
    throw new ExecError("outside_workplace");
  return {
    path,
    identity,
    home: homeIdentity,
    parent,
    absentPaths,
    version: gitConfigurationDigest({
      identity,
      parent: directoryKey(parent),
      home: directoryKey(homeIdentity),
      absentPaths,
    }),
  };
}

/** Facts locate the requested object; independent physical roots and the call assertion supply authority. */
export async function gitConfigurationPublicationPlan(
  input: GitConfigurationPublishInput,
  signal: AbortSignal,
): Promise<GitPublicationPlan> {
  if (
    input.target !== "local" ||
    input.process.platform !== process.platform ||
    !["darwin", "linux"].includes(process.platform)
  )
    throw new ExecError("isolation_unavailable");
  const requested = input.parsed.intent,
    facts = input.preparedFacts;
  if (
    !!input.hooksPath !== (facts.operation === "hooks-path") ||
    !!input.knownFile !== (facts.operation === "known-file") ||
    (input.knownFile &&
      (process.platform !== "darwin" ||
        input.registeredBranch ||
        !knownConfigurationFileMatches(input.knownFile, facts)))
  )
    throw new ExecError("authorization_changed");
  if (!requested || typeof input.assertCurrentCall !== "function")
    throw new ExecError("invalid_input");
  const parsed = gitConfigurationIntent(
    {
      program: requested.program,
      args: gitConfigurationArguments(requested),
    },
    requested.cwd,
  );
  const intent = parsed.intent;
  const upstream = intent?.recipe?.kind === "branch-upstream";
  const keys =
    intent && !upstream ? gitConfigurationChanges(intent).map((change) => change.key) : [];
  if (
    !intent ||
    intent.digest !== requested.digest ||
    facts.version !== 1 ||
    facts.authority !== "none" ||
    facts.scope !== intent.scope ||
    facts.intentDigest !== intent.digest ||
    (!upstream &&
      (facts.requestedKey !== intent.key ||
        facts.resolvedBranch !== undefined ||
        JSON.stringify(facts.changedKeys) !== JSON.stringify(keys))) ||
    !facts.targetPath ||
    !facts.beforeVersion
  )
    throw new ExecError("invalid_input");
  if (input.hooksPath) {
    if (
      process.platform !== "darwin" ||
      input.knownFile ||
      input.registeredBranch ||
      intent.key !== "core.hookspath"
    )
      throw new ExecError("authorization_changed");
    assertHooksPathPublication(input.hooksPath, intent, facts, signal);
  }
  if (input.registeredBranch) {
    const plan = await registeredBranchPublicationPlan(input, signal);
    if (
      facts.status !== "candidate" ||
      facts.reason !== "managed_branch_candidate" ||
      !facts.candidateDigest ||
      facts.beforeVersion !== input.registeredBranch.beforeVersion ||
      facts.targetPath !== plan.targetPath
    )
      throw new ExecError("invalid_input");
    return plan;
  }
  if (intent.scope === "global") {
    if (
      facts.status !== "confirmation-required" ||
      facts.reason !== "global_confirmation_required" ||
      !/^user\.(?:name|email)$/.test(intent.key) ||
      facts.candidateDigest
    )
      throw new ExecError("invalid_input");
    const global = await globalGitConfigurationMetadata(input.userHome, input.process.env);
    if (global.path !== facts.targetPath || global.version !== facts.beforeVersion)
      throw new ExecError("file_conflict");
    return {
      intent,
      targetPath: global.path,
      expectedIdentity: global.identity,
      directories: [directoryKey(global.home), directoryKey(global.parent)],
      absentPaths: global.absentPaths,
    };
  }
  const sensitive = parsed.reason === "sensitive_project_confirmation_required";
  if (
    facts.status !== (sensitive ? "confirmation-required" : "candidate") ||
    facts.reason !==
      (input.hooksPath
        ? "hooks_path_candidate"
        : sensitive
          ? "sensitive_project_confirmation_required"
          : "ordinary_project_candidate") ||
    !facts.candidateDigest
  )
    throw new ExecError("invalid_input");
  await verifyWorkspace(input.rootIdentities, signal);
  if ((await realpath(intent.cwd)) !== intent.cwd) throw new ExecError("outside_workplace");
  const repo = input.snapshot.repositories.find(
    (item) =>
      item.kind === "ordinary" &&
      item.gitDir &&
      join(item.gitDir, "config") === facts.targetPath &&
      item.worktree &&
      within(item.worktree, intent.cwd),
  );
  if (
    !repo?.gitDir ||
    !repo.worktree ||
    repo.gitDir !== join(repo.worktree, ".git") ||
    repo.commonDir !== repo.gitDir ||
    (await gitResourceIdentity(join(repo.gitDir, "commondir"))) ||
    (await gitResourceIdentity(join(repo.gitDir, "worktrees")))
  )
    throw new ExecError("outside_workplace");
  const owner = input.writeRoots
    .filter((root) => within(root, facts.targetPath as string))
    .sort((a, b) => b.length - a.length)[0];
  const root = input.rootIdentities.find(
    (item) => item.canonicalPath === owner && item.role !== "readonly",
  );
  const gitDir = input.snapshot.resources.find(
    (item) => item.kind === "git-directory" && item.path === repo.gitDir,
  )?.identity;
  const config = input.snapshot.resources.find(
    (item) => item.kind === "config" && item.path === facts.targetPath,
  );
  if (
    !owner ||
    !root?.device ||
    !root.inode ||
    !gitDir ||
    !config?.identity ||
    !config.hash ||
    input.denyWriteRoots.some((path) => within(path, facts.targetPath as string))
  )
    throw new ExecError("outside_workplace");
  const resolved = await resolveGitUpstream(intent, repo.gitDir, signal);
  const publicationIntent = resolved.intent;
  if (
    facts.requestedKey !== publicationIntent.key ||
    facts.resolvedBranch !== resolved.upstream?.branch ||
    JSON.stringify(facts.changedKeys) !==
      JSON.stringify(gitConfigurationChanges(publicationIntent).map((change) => change.key)) ||
    gitConfigurationDigest({
      identity: config.identity,
      hash: config.hash,
      ...(resolved.upstream ? { upstream: resolved.upstream } : {}),
    }) !== facts.beforeVersion
  )
    throw new ExecError("file_conflict");
  return {
    intent: publicationIntent,
    targetPath: facts.targetPath,
    expectedIdentity: config.identity,
    expectedHash: config.hash,
    directories: [
      { path: owner, device: root.device, inode: root.inode },
      directoryKey(gitDir),
      ...(input.hooksPath ? hooksPathConfigurationDirectories(input.hooksPath) : []),
      ...(resolved.upstream?.directories ?? []),
      ...(resolved.upstream?.objects.flatMap((item) =>
        item.identity?.type === "directory" ? [directoryKey(item.identity)] : [],
      ) ?? []),
    ],
    absentPaths: [
      join(repo.gitDir, "commondir"),
      join(repo.gitDir, "worktrees"),
      ...(input.knownFile || input.hooksPath ? [join(repo.gitDir, "config.worktree")] : []),
    ],
    ...(resolved.upstream ? { upstream: resolved.upstream } : {}),
  };
}
