import {
  canonicalPath,
  HostSshConfigError,
  HostSshError,
  hostSshIntent,
  type PreparedHostSsh,
  prepareHostSsh,
} from "@pibot/execution";
import { type CommandAnalysis, containsPath, expandHome } from "@pibot/policy";
import {
  type HostSshFacts,
  HostSshFactsSchema,
  type ResolvedWorkplace,
} from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

export interface PreparedHostSshCall {
  facts: HostSshFacts;
  /** Paths and configuration versions never leave the trusted process. */
  recipe?: PreparedHostSsh;
}

export async function prepareRunHostSsh(
  local: LocalService,
  context: ToolRunContext,
  args: RunCommandArgs,
  workplace: ResolvedWorkplace,
  analysis: CommandAnalysis,
  signal: AbortSignal,
): Promise<PreparedHostSshCall | undefined> {
  const literal = analysis.literalCommand;
  const selected = literal && ["ssh", "/usr/bin/ssh"].includes(literal.program);
  if (
    !selected &&
    !analysis.commands.some((command) => /^(?:ssh|.*[/\\]ssh(?:\.exe)?)$/.test(command.program))
  )
    return undefined;
  /** The refused line travels with the facts so the model can name what to fix. */
  const unsupported = (
    reason: HostSshFacts["reason"],
    extra?: Pick<HostSshFacts, "configDetail" | "configOption">,
  ): PreparedHostSshCall => ({
    facts: { version: 1, status: "unsupported", reason, authority: "none", ...extra },
  });
  const intent = literal ? hostSshIntent(literal) : undefined;
  if (!intent) return unsupported("unsupported_syntax");
  if (
    local.deps.platform !== "darwin" ||
    process.platform !== "darwin" ||
    workplace.boundary.location?.target !== "local" ||
    args.background ||
    args.docker ||
    args.writePaths?.length ||
    context.routineRunId ||
    context.routineWorkplace ||
    context.routineSource ||
    context.routineResume
  )
    return unsupported("unsupported_target");
  // Only hosts the person enabled in settings may run. The alias still comes from their own
  // ~/.ssh/config; a host they did not enable stays unusable, whatever the model asks.
  const setting = local.permissions.repo.get().sshHosts?.[intent.alias];
  if (!setting?.enabled) return unsupported("not_enabled");
  const cwd = await canonicalPath(
    expandHome(args.cwd ?? workplace.cwd, workplace.home),
    workplace.cwd,
  );
  // The ordinary policy still verifies this cwd and its writable workplace. No new root is granted.
  if (
    !workplace.boundary.writeRoots.some((root) => containsPath(root, cwd, local.deps.platform)) ||
    workplace.boundary.denyWriteRoots.some((root) => containsPath(root, cwd, local.deps.platform))
  )
    return unsupported("unsupported_target");
  try {
    const recipe = await prepareHostSsh(
      {
        intent,
        userHome: local.deps.userHome,
        platform: local.deps.platform,
        // An Include inside any workplace or Bot home is Bot-writable; refuse it here too.
        forbiddenRoots: [...workplace.boundary.readRoots, workplace.home],
        ...(setting.identity ? { identity: setting.identity } : {}),
      },
      signal,
    );
    return {
      recipe,
      facts: HostSshFactsSchema.parse({
        version: 1,
        status: "candidate",
        reason: "confirmation_required",
        authority: "none",
        alias: intent.alias,
        hostname: recipe.hostname,
        port: recipe.port,
        intentDigest: intent.digest,
        resourceVersion: recipe.version,
        dependencyCount: recipe.files.length,
      }),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof HostSshConfigError)
      return unsupported("unsupported_configuration", {
        configDetail: error.detail,
        ...(error.option ? { configOption: error.option } : {}),
      });
    if (error instanceof HostSshError) return unsupported(error.reason);
    throw error;
  }
}

export function hostSshFingerprint(prepared: PreparedHostSshCall | undefined) {
  return prepared ? { facts: prepared.facts, version: prepared.recipe?.version } : undefined;
}
