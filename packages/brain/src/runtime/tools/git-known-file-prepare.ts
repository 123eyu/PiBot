import { join, resolve } from "node:path";
import {
  canonicalPath,
  ExecError,
  type GitConfigurationCandidateInput,
  inspectGitResources,
  knownConfigurationFileMatches,
  knownConfigurationFileRequestMatches,
  prepareKnownGitConfigurationFile,
} from "@pibot/execution";
import { expandHome } from "@pibot/policy";
import type { GitConfigurationFacts, ResolvedWorkplace } from "@pibot/protocol-base";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import {
  type PreparedGitConfiguration,
  prepareGitConfigurationFacts,
} from "./git-configuration-prepare.ts";

export function gitKnownFileAdapter(
  prepared: PreparedGitConfiguration,
  callId: string,
  args: { path: string; content: string },
) {
  const plan = prepared.input?.knownFile;
  const bound = { callId, path: args.path, content: args.content };
  return {
    verifyCurrent: (facts: GitConfigurationFacts, path: string): "current" | "changed" =>
      path === bound.path &&
      knownConfigurationFileMatches(plan, facts) &&
      knownConfigurationFileRequestMatches(plan, bound)
        ? "current"
        : "changed",
  };
}

/** Every recognized config file attempt stays on this branch, including unsupported requests. */
export async function prepareWriteGitConfiguration(
  local: LocalService,
  context: ToolRunContext,
  args: { path: string; content: string },
  workplace: ResolvedWorkplace,
  callId: string,
  request: AbortSignal,
): Promise<PreparedGitConfiguration | undefined> {
  const recognized = (path: string) =>
    /[\\/]\.git[\\/]config(?:\.worktree)?$/i.test(path) ||
    path === join(local.deps.userHome, ".gitconfig") ||
    path === join(local.deps.userHome, ".config", "git", "config") ||
    (typeof local.deps.env.XDG_CONFIG_HOME === "string" &&
      path === join(local.deps.env.XDG_CONFIG_HOME, "git", "config"));
  const lexical = resolve(workplace.cwd, expandHome(args.path, workplace.home));
  const possible = recognized(lexical);
  // Other platforms never resolve a foreign path using this host's filesystem.
  if (
    !possible &&
    (local.deps.platform !== process.platform || workplace.boundary.location?.target !== "local")
  )
    return undefined;
  const path =
    local.deps.platform === process.platform && workplace.boundary.location?.target === "local"
      ? await canonicalPath(lexical, workplace.cwd)
      : lexical;
  if (!possible && !recognized(path)) return undefined;
  const unsupported: PreparedGitConfiguration = {
    facts: {
      version: 1,
      operation: "known-file",
      status: "unsupported",
      reason: "scope_unverified",
      scope: "project",
      changedKeys: [],
      authority: "none",
    },
  };
  if (
    local.deps.platform !== "darwin" ||
    process.platform !== "darwin" ||
    workplace.boundary.location?.target !== "local" ||
    path !== lexical ||
    path !== resolve(workplace.cwd, ".git", "config") ||
    context.executionTaskId ||
    context.routineRunId ||
    context.routineWorkplace ||
    context.routineSource ||
    context.routineResume
  )
    return unsupported;
  const signal = AbortSignal.any([request, AbortSignal.timeout(10_000)]);
  const roots = workplace.boundary.roots;
  const rootFact = (root: (typeof roots)[number]) => ({
    path: root.canonicalPath,
    ...(root.device ? { device: root.device } : {}),
    ...(root.inode ? { inode: root.inode } : {}),
  });
  const snapshot = await inspectGitResources(
    {
      cwd: workplace.cwd,
      targetsOnly: true,
      targets: [workplace.cwd],
      writeRoots: roots.filter((root) => root.role !== "readonly").map(rootFact),
      readOnlyRoots: roots.filter((root) => root.role === "readonly").map(rootFact),
      protectedRoots: workplace.boundary.denyWriteRoots,
    },
    signal,
  );
  const base = {
    snapshot,
    rootIdentities: roots,
    writeRoots: workplace.boundary.writeRoots,
    denyWriteRoots: workplace.boundary.denyWriteRoots,
    privateTempRoot: local.deps.tempDir,
    userHome: local.deps.userHome,
    process: { platform: local.deps.platform, env: {} },
  };
  try {
    const plan = await prepareKnownGitConfigurationFile(
      { ...base, path, content: args.content, callId, requestedPath: args.path },
      signal,
    );
    const input: GitConfigurationCandidateInput = { ...base, ...plan };
    const { facts } = await prepareGitConfigurationFacts(input, signal);
    if (!knownConfigurationFileMatches(input.knownFile, facts)) return unsupported;
    return { input, facts };
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ExecError) || error.reason === "cleanup_failed") throw error;
    return unsupported;
  }
}
