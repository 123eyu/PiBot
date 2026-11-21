import type { LocalToolResult } from "@pibot/agent";
import {
  ExecError,
  type GitConfigurationCallRequirement,
  GitConfigurationPublicationUnconfirmedError,
  knownConfigurationFileMatches,
  knownConfigurationFileRequestMatches,
  publishGitConfiguration,
  verifyHooksPathConfiguration,
} from "@pibot/execution";
import {
  GIT_CONFIGURATION_CONFIRMATION_REASON,
  GIT_HOOKS_PATH_CONFIRMATION_REASON,
} from "@pibot/policy";
import { type AuditDetail, gitConfigurationNeedsConfirmation } from "@pibot/protocol-base";
import type { PreparedTool } from "../../core/local-types.ts";
import type { LocalRun } from "./local-run.ts";

function finishAudit(run: LocalRun, summary: string, fields: AuditDetail, file = false) {
  try {
    if (file) run.auditWritten([{ summary, detail: fields }]);
    else run.auditCommand("finished", summary, fields);
    return true;
  } catch {
    // Audit failure cannot change an already-published or unprovable filesystem outcome.
    run.local.deps.logger.warn(
      JSON.stringify({
        module: "git-configuration",
        event: "completion_audit_failed",
        runId: run.context.runId,
      }),
    );
    return false;
  }
}

/** This closure can only consume the LocalRun's already-authorized, exact prepared call. */
export function assertGitConfigurationDispatch(
  run: Pick<LocalRun, "assertDispatch" | "context">,
  prepared: PreparedTool,
  requirement: Readonly<GitConfigurationCallRequirement>,
) {
  run.assertDispatch(prepared);
  const facts = prepared.gitConfiguration?.facts;
  const file = prepared.call.tool === "write_file";
  if (file) {
    const args = prepared.call.input as { path: string; content: string };
    if (
      !facts ||
      !knownConfigurationFileMatches(prepared.gitConfiguration?.input?.knownFile, facts) ||
      !knownConfigurationFileRequestMatches(prepared.gitConfiguration?.input?.knownFile, {
        callId: prepared.call.id,
        ...args,
      })
    )
      throw new ExecError("authorization_changed");
  } else if (facts?.operation === "known-file" || prepared.gitConfiguration?.input?.knownFile)
    throw new ExecError("authorization_changed");
  const hooksPath = facts?.operation === "hooks-path";
  if (hooksPath) {
    if (
      file ||
      prepared.call.tool !== "run_command" ||
      typeof prepared.call.input.command !== "string"
    )
      throw new ExecError("authorization_changed");
    verifyHooksPathConfiguration(
      prepared.gitConfiguration?.input?.hooksPath,
      facts,
      { callId: prepared.call.id, command: prepared.call.input.command },
      run.context.signal,
    );
  } else if (prepared.gitConfiguration?.input?.hooksPath)
    throw new ExecError("authorization_changed");
  const mandatory =
    !!facts && (facts.scope === "global" || hooksPath || gitConfigurationNeedsConfirmation(facts));
  if (
    !facts ||
    prepared.result.decision === "deny" ||
    requirement.scope !== facts.scope ||
    requirement.key !== facts.requestedKey ||
    JSON.stringify(requirement.changedKeys) !== JSON.stringify(facts.changedKeys) ||
    requirement.targetPath !== facts.targetPath ||
    requirement.intentDigest !== facts.intentDigest ||
    requirement.beforeVersion !== facts.beforeVersion ||
    requirement.explicitConfirmationRequired !== mandatory ||
    (mandatory &&
      (prepared.confirmedNow !== true ||
        prepared.result.decision !== "ask" ||
        prepared.result.reason !==
          (hooksPath
            ? GIT_HOOKS_PATH_CONFIRMATION_REASON
            : GIT_CONFIGURATION_CONFIRMATION_REASON) ||
        prepared.result.canRemember ||
        prepared.result.grantScope))
  )
    throw new ExecError("authorization_changed");
}

/** Selected-but-unsupported recipes fail closed; they never fall back to a shell. */
export async function executeGitConfiguration(
  run: LocalRun,
  prepared: PreparedTool,
  fields: AuditDetail,
  signal: AbortSignal,
): Promise<LocalToolResult> {
  const recipe = prepared.gitConfiguration;
  if (!recipe?.input || !["candidate", "confirmation-required"].includes(recipe.facts.status))
    throw new ExecError("isolation_unavailable");
  const recipeInput = recipe.input;
  const file = prepared.call.tool === "write_file";
  run.assertDispatch(prepared);
  run.clearCommandChecks();
  // The exact config body must not enter general workspace change cards or auto-formatting.
  if (!file) await run.watchCommandRoots(prepared);
  const audit = {
    ...fields,
    target: file
      ? recipe.facts.targetPath
      : `git config ${recipe.facts.scope} ${recipe.facts.changedKeys.join(",")}`,
    ...(file
      ? {}
      : { command: `git config ${recipe.facts.scope} ${recipe.facts.changedKeys.join(",")}` }),
  };
  if (!file) run.auditCommand("started", "Git configuration started / 开始修改Git配置", audit);
  const started = performance.now();
  try {
    const publish = (assertManagedCurrent?: () => void) =>
      publishGitConfiguration(
        {
          ...recipeInput,
          target: "local",
          preparedFacts: recipe.facts,
          assertCurrentCall: (requirement) => {
            assertGitConfigurationDispatch(run, prepared, requirement);
            assertManagedCurrent?.();
          },
        },
        signal,
      );
    const receipt = recipe.managed
      ? await run.managedConfigurationPublication(prepared, signal, publish)
      : await publish();
    const fields = {
      ...audit,
      reasonCode: "git_configuration_applied",
      bytes: receipt.bytes,
      durationMs: Math.round(performance.now() - started),
      stopped: receipt.cancelledAfterPublication,
    };
    const audited = finishAudit(run, "Git configuration applied / Git配置已应用", fields, file);
    return {
      text: `Git配置已应用 / Git configuration applied\n${JSON.stringify({ ...receipt, ...(audited ? {} : { audit: "unconfirmed" }) })}`,
      details: {
        exitCode: 0,
        durationMs: Math.round(performance.now() - started),
      },
    };
  } catch (error) {
    if (!(error instanceof GitConfigurationPublicationUnconfirmedError)) throw error;
    finishAudit(
      run,
      "Git publication unconfirmed / Git发布结果无法确认",
      {
        ...audit,
        reasonCode: "git_configuration_publication_unconfirmed",
        durationMs: Math.round(performance.now() - started),
      },
      file,
    );
    return {
      isError: true,
      text: `无法确认Git配置是否已经应用，请人工核实；禁止自动重试或改用Shell重复执行 / Git configuration publication is unconfirmed. Verify it manually; do not retry automatically or repeat it through a shell.\n${JSON.stringify({ status: "unconfirmed", publication: "unconfirmed", retryable: false })}`,
      // Existing journal semantics keep commands with an unknown exit in the non-replayable state.
      details: {
        exitCode: null,
        errorCode: "git_configuration_publication_unconfirmed",
      },
    };
  }
}
