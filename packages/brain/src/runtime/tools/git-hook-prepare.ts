import { type GitHookPlan, prepareGitHook, selectedGitHook } from "@pibot/execution";
import { type CommandAnalysis, containsPath } from "@pibot/policy";
import {
  type GitHookFacts,
  GitHookFactsSchema,
  type ResolvedWorkplace,
} from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

export interface PreparedGitHook {
  facts: GitHookFacts;
  plan?: GitHookPlan;
}

export async function prepareRunGitHook(
  local: LocalService,
  context: ToolRunContext,
  args: RunCommandArgs,
  workplace: ResolvedWorkplace,
  analysis: CommandAnalysis,
  signal: AbortSignal,
): Promise<PreparedGitHook | undefined> {
  if (!analysis.commands.some((command) => selectedGitHook(command.program, command.args))) return;
  const unsupported: PreparedGitHook = {
    facts: { version: 1, status: "unsupported", reason: "unsupported_syntax", authority: "none" },
  };
  if (
    args.command !== "git hook run pre-commit" ||
    !analysis.literalCommand ||
    args.background ||
    args.docker ||
    args.outsideSandbox ||
    args.writePaths?.length
  )
    return unsupported;
  unsupported.facts.reason = "unsupported_scope";
  if (
    (local.deps.platform !== "darwin" && local.deps.platform !== "linux") ||
    process.platform !== local.deps.platform ||
    workplace.boundary.location?.target !== "local" ||
    context.routineRunId ||
    context.routineWorkplace ||
    context.routineSource ||
    context.routineResume
  )
    return unsupported;
  const cwd = args.cwd ?? workplace.cwd;
  if (!workplace.boundary.writeRoots.some((root) => containsPath(root, cwd, local.deps.platform)))
    return unsupported;
  const result = await prepareGitHook(
    {
      command: args.command,
      cwd,
      botHome: workplace.home,
      privateTempRoot: local.deps.tempDir,
      rootIdentities: workplace.boundary.roots,
      writeRoots: workplace.boundary.writeRoots,
      denyWriteRoots: workplace.boundary.denyWriteRoots,
    },
    signal,
  );
  return {
    facts: GitHookFactsSchema.parse(result.facts),
    ...(result.plan ? { plan: result.plan } : {}),
  };
}

export function gitHookFingerprint(value: PreparedGitHook | undefined) {
  return value
    ? {
        facts: value.facts,
        roots: value.plan?.rootIdentities,
        writes: value.plan?.writeRoots,
        denied: value.plan?.denyWriteRoots,
      }
    : undefined;
}
