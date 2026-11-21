import { dirname } from "node:path";
import {
  canonicalPath,
  ExecError,
  type GitConfigurationCandidateInput,
  gitConfigurationIntent,
  inspectGitResources,
  prepareGitConfigurationCandidate,
  prepareHooksPathConfiguration,
  verifyHooksPathConfiguration,
} from "@pibot/execution";
import {
  type CommandAnalysis,
  classifyGitConfiguration,
  containsPath,
  expandHome,
  type GitConfigurationClassification,
} from "@pibot/policy";
import {
  type GitConfigurationFacts,
  GitConfigurationFactsSchema,
  gitConfigurationNeedsConfirmation,
  type ResolvedWorkplace,
} from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

export interface PreparedGitConfiguration {
  facts: GitConfigurationFacts;
  /** Private recipe input; never serialized into cards, audits or the tool fingerprint. */
  input?: GitConfigurationCandidateInput;
  managed?: import("../workspaces/managed-config-port.ts").ManagedBranchConfigurationHandle;
}

/** Execution diagnostics remain pure facts; the shared evaluator alone decides permission. */
export async function prepareGitConfigurationFacts(
  input: Parameters<typeof prepareGitConfigurationCandidate>[0],
  signal: AbortSignal,
): Promise<{ facts: GitConfigurationFacts; classification: GitConfigurationClassification }> {
  const facts = GitConfigurationFactsSchema.parse(
    await prepareGitConfigurationCandidate(input, signal),
  );
  return { facts, classification: classifyGitConfiguration(facts) };
}

/** Recognized unsupported configuration mutations never fall back to a shell. */
export async function prepareRunGitConfiguration(
  local: LocalService,
  context: ToolRunContext,
  args: RunCommandArgs,
  workplace: ResolvedWorkplace,
  analysis: CommandAnalysis,
  signal: AbortSignal,
  toolCallId: string,
): Promise<PreparedGitConfiguration | undefined> {
  const literal = analysis.literalCommand;
  const parsed = literal ? gitConfigurationIntent(literal, workplace.cwd) : undefined;
  if (!literal || !parsed?.intent) {
    const remoteMutation = analysis.commands.some(
      (command) =>
        /^(?:git|.*[/\\]git(?:\.exe)?)$/.test(command.program) &&
        ((command.args[0] === "remote" && ["add", "set-url"].includes(command.args[1] ?? "")) ||
          (command.args[0] === "branch" &&
            command.args.some(
              (arg) => arg === "--set-upstream-to" || arg.startsWith("--set-upstream-to="),
            ))),
    );
    if (!remoteMutation) return undefined;
    return {
      facts: {
        version: 1,
        status: "unsupported",
        reason: parsed?.reason ?? "unsupported_syntax",
        scope: "project",
        changedKeys: [],
        authority: "none",
      },
    };
  }
  const sensitive = parsed.intent.key === "core.hookspath";
  const unsupported: PreparedGitConfiguration = {
    facts: {
      version: 1,
      status: "unsupported",
      reason: "scope_unverified",
      scope: parsed.intent.scope,
      requestedKey: parsed.intent.key,
      intentDigest: parsed.intent.digest,
      changedKeys: [],
      authority: "none",
    },
  };
  if (
    workplace.boundary.location?.target !== "local" ||
    !["darwin", "linux"].includes(local.deps.platform) ||
    local.deps.platform !== process.platform ||
    args.background ||
    args.docker ||
    (sensitive &&
      (local.deps.platform !== "darwin" ||
        context.executionTaskId ||
        context.routineRunId ||
        context.routineWorkplace ||
        context.routineSource ||
        context.routineResume)) ||
    (gitConfigurationNeedsConfirmation({ scope: parsed.intent.scope, reason: parsed.reason }) &&
      (context.routineRunId ||
        context.routineWorkplace ||
        context.routineSource ||
        context.routineResume))
  )
    return unsupported;
  const cwd = await canonicalPath(
    expandHome(args.cwd ?? workplace.cwd, workplace.home),
    workplace.cwd,
  );
  const intent = gitConfigurationIntent(literal, cwd);
  if (!intent.intent) return unsupported;
  // Inspect only known ancestor layouts. Broad tree coverage is neither needed nor promised here.
  const roots = workplace.boundary.roots;
  const owner = workplace.boundary.writeRoots
    .filter((root) => containsPath(root, cwd, local.deps.platform))
    .sort((a, b) => b.length - a.length)[0];
  const targets: string[] = [];
  if (owner && intent.intent.scope === "project") {
    for (
      let path = cwd;
      containsPath(owner, path, local.deps.platform) && targets.length < 64;
      path = dirname(path)
    ) {
      targets.push(path);
      if (path === owner) break;
    }
  }
  const resourceRoot = (root: (typeof roots)[number]) => ({
    path: root.canonicalPath,
    ...(root.device ? { device: root.device } : {}),
    ...(root.inode ? { inode: root.inode } : {}),
  });
  const snapshot = await inspectGitResources(
    {
      cwd,
      targetsOnly: true,
      writeRoots: roots.filter((root) => root.role !== "readonly").map(resourceRoot),
      readOnlyRoots: roots.filter((root) => root.role === "readonly").map(resourceRoot),
      targets,
      protectedRoots: workplace.boundary.denyWriteRoots,
    },
    signal,
  );
  const managed =
    intent.intent.scope === "project" && local.deps.platform === "darwin"
      ? await local.changes.managedConfiguration?.prepare(
          {
            context,
            toolCallId,
            intent: intent.intent,
            primaryRootId: workplace.boundary.primaryId,
          },
          signal,
        )
      : undefined;
  const input: GitConfigurationCandidateInput = {
    ...(managed ? { registeredBranch: managed.plan } : {}),
    parsed: intent,
    snapshot,
    rootIdentities: roots,
    writeRoots: workplace.boundary.writeRoots,
    denyWriteRoots: workplace.boundary.denyWriteRoots,
    privateTempRoot: local.deps.tempDir,
    userHome: local.deps.userHome,
    process: {
      platform: local.deps.platform,
      env: { XDG_CONFIG_HOME: local.deps.env.XDG_CONFIG_HOME },
    },
  };
  if (sensitive) {
    try {
      input.hooksPath = prepareHooksPathConfiguration(
        input,
        { callId: toolCallId, command: args.command },
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ExecError) return unsupported;
      throw error;
    }
  }
  const { facts } = await prepareGitConfigurationFacts(input, signal);
  return { input, facts, ...(managed ? { managed } : {}) };
}

export function gitConfigurationFingerprint(prepared: PreparedGitConfiguration | undefined) {
  if (!prepared) return undefined;
  const input = prepared.input;
  return {
    facts: prepared.facts,
    managedBinding: prepared.managed?.binding,
    intentDigest: input?.parsed.intent?.digest,
    rootIdentities: input?.rootIdentities,
    writeRoots: input?.writeRoots,
    denyWriteRoots: input?.denyWriteRoots,
    targetResources: input?.snapshot.resources.filter(
      (item) =>
        item.path === prepared.facts.targetPath ||
        (item.kind === "git-directory" &&
          prepared.facts.targetPath &&
          item.path === dirname(prepared.facts.targetPath)),
    ),
  };
}

export function gitHooksPathAdapter(
  prepared: PreparedGitConfiguration,
  callId: string,
  command: string,
  signal: AbortSignal,
) {
  return {
    verifyCurrent(facts: GitConfigurationFacts, requested: string): "current" | "changed" {
      if (requested !== command) return "changed";
      try {
        verifyHooksPathConfiguration(prepared.input?.hooksPath, facts, { callId, command }, signal);
        return "current";
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ExecError) return "changed";
        throw error;
      }
    },
  };
}
