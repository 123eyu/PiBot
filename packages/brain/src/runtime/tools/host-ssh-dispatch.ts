import type { LocalToolResult } from "@pibot/agent";
import { ExecError, HostSshError, hostSshIntent, verifyPreparedHostSsh } from "@pibot/execution";
import type { AuditDetail } from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import type { PreparedTool } from "../../core/local-types.ts";
import type { LocalRun } from "./local-run.ts";

/** This receipt belongs to one current call, never to an alias, Bot, routine or remembered grant. */
export function assertHostSshDispatch(
  run: Pick<LocalRun, "assertDispatch" | "context">,
  prepared: PreparedTool,
) {
  run.assertDispatch(prepared);
  const recipe = prepared.hostSsh?.recipe;
  const facts = prepared.hostSsh?.facts;
  if (
    !recipe ||
    !facts ||
    facts.status !== "candidate" ||
    facts.resourceVersion !== recipe.version ||
    facts.intentDigest !== recipe.intent.digest ||
    prepared.result.decision === "deny" ||
    // An enabled host follows run_command's own level and YOLO, so only a call the person is
    // still being asked about needs their answer from this exact call.
    (prepared.result.decision === "ask" && prepared.confirmedNow !== true) ||
    prepared.result.canRemember ||
    prepared.result.grantScope ||
    prepared.secretUses?.length ||
    prepared.gitConfiguration ||
    prepared.gitHook ||
    prepared.docker ||
    prepared.boundary?.location?.target !== "local" ||
    run.context.routineRunId ||
    run.context.routineWorkplace ||
    run.context.routineSource ||
    run.context.routineResume
  )
    throw new ExecError("authorization_changed");
}

/**
 * 255 is OpenSSH's own failure code, but a remote command can return it too, and this entry
 * suppresses every local diagnostic and remote stderr. A fixed hint is therefore the only safe
 * way to help the model tell "cannot connect or authenticate" from "the command failed".
 */
function describeHostSshOutcome(
  result: { exitCode: number | null; timedOut: boolean; stopped: boolean },
  alias: string,
) {
  if (result.stopped) return "已停止 / Stopped";
  if (result.timedOut) return "执行超时 / Command timed out";
  if (result.exitCode === 255)
    return `退出码 / Exit code: 255（通常是连接或认证失败，也可能是远端命令自己返回 255；请让用户在终端里试 \`ssh ${alias}\` 确认 / usually a connection or authentication failure, though the remote command may also exit 255; ask the user to check with \`ssh ${alias}\` in a terminal）`;
  return `退出码 / Exit code: ${result.exitCode ?? "unknown"}`;
}

export async function executeHostSsh(
  run: LocalRun,
  prepared: PreparedTool,
  args: RunCommandArgs,
  fields: AuditDetail,
  signal: AbortSignal,
  output: (text: string) => void,
): Promise<LocalToolResult> {
  assertHostSshDispatch(run, prepared);
  const recipe = prepared.hostSsh?.recipe;
  const literal = (await run.local.getPolicy(signal)).analyzeCommand(args.command).literalCommand;
  if (
    !recipe ||
    !literal ||
    hostSshIntent(literal)?.digest !== recipe.intent.digest ||
    args.background ||
    args.docker ||
    args.writePaths?.length
  )
    throw new ExecError("authorization_changed");
  try {
    await verifyPreparedHostSsh(recipe, signal);
  } catch (error) {
    if (error instanceof HostSshError) throw new ExecError("authorization_changed");
    throw error;
  }
  const isolation = await run.target.isolationStatus(signal);
  if (!isolation.available) throw new ExecError("isolation_unavailable");
  // The address comes from this call's own SSH recipe, not from a general web allowlist.
  // Add only hostname:port for this one command so a private host can still be reached without
  // widening the stored network settings or letting other calls resolve it.
  const targetAddress = `${recipe.hostname}:${recipe.port}`;
  const network = {
    ...prepared.settings.network,
    domains: [...new Set([...prepared.settings.network.domains, targetAddress])],
  };
  run.clearCommandChecks();
  await run.watchCommandRoots(prepared);
  assertHostSshDispatch(run, prepared);
  const audit = {
    ...fields,
    command: `ssh ${recipe.intent.alias} <remote command>`,
    target: `ssh ${recipe.intent.alias} <remote command>`,
  };
  run.auditCommand("started", "SSH command started / SSH命令开始", audit);
  const result = await run.target.runCommand({
    command: audit.command,
    hostSsh: recipe,
    timeoutSec: args.timeoutSec,
    rootIdentities: prepared.boundary?.roots,
    denyWriteRoots: prepared.boundary?.denyWriteRoots,
    cwd: prepared.cwd,
    dataDir: run.dataDir,
    botHome: prepared.home,
    skillGroupId: run.commandGroupId(),
    skillPackageIds: run.commandSkillPackageIds(),
    runId: run.context.runId,
    // Fixed SSH/nc never writes project files. Keep the source approval/identity checks above,
    // without granting local project writes or walking an unrelated whole-project alias tree.
    writeRoots: [],
    network,
    privateNetworkHosts: [targetAddress],
    pathEntries: prepared.settings.pathEntries,
    signal,
    onOutput: output,
    assertAuthorized: () => assertHostSshDispatch(run, prepared),
  });
  run.auditCommand("finished", "SSH command finished / SSH命令结束", {
    ...audit,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stopped: result.stopped,
  });
  return {
    text: `${result.truncatedOutput}\n${describeHostSshOutcome(result, recipe.intent.alias)}\n本入口不返回本地 SSH 诊断或远端 stderr / Local SSH diagnostics and remote stderr are suppressed.`,
    untrustedContent: result.truncatedOutput.length > 0,
    isError: result.stopped || result.timedOut || result.exitCode !== 0,
    details: { exitCode: result.exitCode, durationMs: result.durationMs, logPath: result.logPath },
  };
}
