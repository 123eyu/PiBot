import { ExecError } from "@pibot/execution";
import { GIT_HOOK_CONFIRMATION_REASON } from "@pibot/policy";
import type { AuditDetail, GitHookFacts } from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import type { PreparedTool } from "../../core/local-types.ts";
import type { LocalRun } from "./local-run.ts";

function finishAudit(run: LocalRun, summary: string, fields: AuditDetail) {
  try {
    run.auditCommand("finished", summary, fields);
    return true;
  } catch {
    // Audit storage failure must not turn an already-finished hook into an automatic replay.
    run.local.deps.logger.warn(
      JSON.stringify({
        module: "git-hook",
        event: "completion_audit_failed",
        runId: run.context.runId,
      }),
    );
    return false;
  }
}

const hookFacts = (facts: GitHookFacts) =>
  JSON.stringify([
    facts.version,
    facts.status,
    facts.reason,
    facts.authority,
    facts.cwd,
    facts.hookPath,
    facts.hookHash,
    facts.program,
    facts.programHash,
    facts.args,
    facts.beforeVersion,
  ]);

export function assertGitHookDispatch(
  run: Pick<LocalRun, "assertDispatch">,
  prepared: PreparedTool,
  facts: GitHookFacts,
) {
  run.assertDispatch(prepared);
  if (
    !prepared.gitHook?.plan ||
    prepared.gitConfiguration ||
    prepared.hostSsh ||
    prepared.confirmedNow !== true ||
    prepared.result.decision !== "ask" ||
    prepared.result.reason !== GIT_HOOK_CONFIRMATION_REASON ||
    prepared.result.risk !== "danger" ||
    prepared.result.canRemember ||
    prepared.result.grantScope ||
    hookFacts(facts) !== hookFacts(prepared.gitHook.facts)
  )
    throw new ExecError("authorization_changed");
}

export async function executeGitHook(
  run: LocalRun,
  prepared: PreparedTool,
  args: RunCommandArgs,
  fields: AuditDetail,
  signal: AbortSignal,
  output: (text: string) => void,
) {
  const recipe = prepared.gitHook;
  if (!recipe?.plan || recipe.facts.status !== "confirmation-required")
    throw new ExecError("isolation_unavailable");
  assertGitHookDispatch(run, prepared, recipe.facts);
  if (prepared.secretUses?.length) throw new ExecError("isolation_unavailable");
  run.clearCommandChecks();
  await run.watchCommandRoots(prepared);
  const audit = {
    ...fields,
    target: "git hook run pre-commit",
    command: "git hook run pre-commit",
    toolCallId: prepared.call.id,
    reasonCode: "git_hook_once",
    sourceDigest: recipe.facts.beforeVersion,
  };
  run.auditCommand("started", "Git hook started / 开始执行Git钩子", audit);
  try {
    const result = await run.target.runCommand({
      command: args.command,
      cwd: prepared.cwd,
      dataDir: run.local.deps.dataDir,
      botHome: prepared.home,
      runId: run.context.runId,
      writeRoots: run.writeRoots(prepared),
      rootIdentities: prepared.boundary?.roots,
      denyWriteRoots: prepared.boundary?.denyWriteRoots,
      network: { allowAll: false, domains: [] },
      timeoutSec: args.timeoutSec,
      signal,
      onOutput: output,
      gitHook: {
        plan: recipe.plan,
        assertCurrentCall: (facts) => assertGitHookDispatch(run, prepared, facts),
      },
      assertAuthorized: () => assertGitHookDispatch(run, prepared, recipe.facts),
    });
    const audited = finishAudit(run, "Git hook finished / Git钩子已结束", {
      ...audit,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stopped: result.stopped,
      timedOut: result.timedOut,
    });
    return {
      text:
        result.truncatedOutput || `Git hook exit / Git钩子退出：${result.exitCode ?? "unknown"}`,
      isError: result.exitCode !== 0,
      untrustedContent: result.truncatedOutput.length > 0,
      details: {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stopped: result.stopped,
        timedOut: result.timedOut,
        logPath: result.logPath,
        ...(audited ? {} : { audit: "unconfirmed" }),
      },
    };
  } catch (error) {
    finishAudit(run, "Git hook failed / Git钩子失败", {
      ...audit,
      stopped: signal.aborted,
      reasonCode: error instanceof ExecError ? error.code : "internal",
    });
    throw error;
  }
}
