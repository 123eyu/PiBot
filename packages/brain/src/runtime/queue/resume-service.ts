import {
  BUDGET_RAISE_SHARE,
  BUDGET_RAISES_MAX,
  interruptedRun,
  type KernelMethodParams,
  type KernelMethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import {
  costRaise,
  MessagesRepo,
  RunEventsRepo,
  RunRecoveryRepo,
  transaction,
} from "@pibot/storage";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { continuationKey } from "../continuation/continuation-keys.ts";
import {
  budgetRaisedResumePrompt,
  interruptedResumePrompt,
  savedGoalPrompt,
} from "../continuation/continuation-prompts.ts";
import { RESUME_NOTE_CALLS, resumeNote } from "../continuation/resume-note.ts";
import { restoreWorkflow } from "../workflows/workflow-recovery.ts";
import { eventBackedRun, type ResumePlan, retryDmRun } from "./retry-service.ts";

/**
 * `runs.resume`: the user's 「继续」 on a run a restart interrupted. It is a retry with a
 * resume plan, so every guard of `runs.retry` applies unchanged (latest run, topic idle, group
 * and task state, session readable, model available) and a second click returns the same run.
 * What differs: the new run keeps the interrupted run's budget root (ledger and execution
 * journal), the model gets Pi Bot's note on the calls with an unknown outcome, and a workflow run
 * stays the same workflow. Permissions are judged again by the new run's own policy checks.
 *
 * `raiseBudget`: the same resume for a workflow run stopped at its cost cap, with the cap
 * raised in the insert transaction (`ResumePlan.raise`) and the amounts on the run.resumed audit.
 */
export async function resumeRun(
  service: GroupOrchestrationPort,
  params: KernelMethodParams["runs.resume"],
): Promise<KernelMethodResults["runs.resume"]> {
  const { botId, conversationId, runId } = params;
  const eventState = new RunEventsRepo(service.deps.db).state(runId);
  const run = eventBackedRun(service, runId, botId, conversationId);
  if (run && params.raiseBudget && run.kind !== "routine") {
    const root = service.deps.local.tasks.budgetRoot(run);
    const started = ["chat-resume", "group-task-resume"]
      .map((kind) => service.runs.trigger(continuationKey(kind, root, run.id)))
      .find(Boolean);
    if (started) return { runId: started.id };
  }
  const groupPlan = run ? service.planBudgetResume?.(run.id) : undefined;
  if (params.raiseBudget && groupPlan?.resumedRunId) return { runId: groupPlan.resumedRunId };
  if (params.raiseBudget && groupPlan?.redirect) {
    groupPlan.assertCurrent();
    return resumeRun(service, { ...params, ...groupPlan.redirect });
  }
  if (
    !run ||
    !eventState ||
    run.kind === "routine" ||
    (!params.raiseBudget && !eventState.interrupted) ||
    (params.raiseBudget
      ? !(budgetStoppedRun(run) || (run.status === "aborted" && groupPlan))
      : !interruptedRun(run))
  )
    throw new RpcError(
      RpcErrorCodes.invalidParams,
      params.raiseBudget ? "budget_raise_unavailable" : "resume_unavailable",
    );
  const local = service.deps.local;
  const persisted = new RunRecoveryRepo(service.deps.db).get(run.id)?.workflow;
  const root = local.tasks.budgetRoot(run);
  if (params.raiseBudget) {
    // Only a workflow's cost cap is the user's to raise; other limits are the conversation's.
    const ledger = local.budgets.repo.get(root);
    if ((!persisted && !groupPlan) || !ledger || ledger.exhaustedReason !== "cost")
      throw new RpcError(RpcErrorCodes.invalidParams, "budget_raise_unavailable");
    if (!costRaise(ledger, BUDGET_RAISE_SHARE, BUDGET_RAISES_MAX))
      throw new RpcError(RpcErrorCodes.invalidParams, "budget_raise_limit");
  }
  if (params.raiseBudget && groupPlan?.budgetOnly) {
    const signal = AbortSignal.any([service.signal, AbortSignal.timeout(25_000)]);
    await groupPlan.budgetOnly.prepare(signal);
    signal.throwIfAborted();
    return transaction(service.deps.db, () => {
      // Another window may have completed its preflight while this one awaited the workplace.
      const duplicate = service.planBudgetResume?.(run.id)?.resumedRunId;
      if (duplicate) return { runId: duplicate };
      groupPlan.assertCurrent();
      const raised = local.budgets.raiseCost(root);
      if (!raised) throw new RpcError(RpcErrorCodes.busy, "budget_raise_unavailable");
      groupPlan.inserted(run.id);
      local.approvals.audit.append({
        botId,
        runId: run.id,
        kind: "run.resumed",
        summary: "Pending plan budget raised / 待开始计划预算已增加",
        detail: {
          actor: "user",
          conversationId,
          target: run.id,
          reasonCode: "budget_raised_pending_plan",
          ...raised,
        },
      });
      return { runId: run.id };
    });
  }
  const workflow = persisted
    ? await restoreWorkflow(local.skills, botId, run.groupId ?? undefined, persisted)
    : undefined;
  // A different version would be a different workflow than the one the user started.
  if (persisted && !workflow)
    throw new RpcError(RpcErrorCodes.invalidParams, "resume_workflow_unavailable");
  const journal = local.toolJournal.repo;
  const goal = run.sessionFile ? "" : savedGoal(service, run);
  const plan: ResumePlan = {
    root,
    note: resumeNote(journal.uncertain(run.id, RESUME_NOTE_CALLS), journal.uncertainCount(run.id)),
    text: params.raiseBudget ? budgetRaisedResumePrompt(goal) : interruptedResumePrompt(goal),
    ...(workflow ? { workflow } : {}),
    ...(params.raiseBudget
      ? {
          raise: () => {
            groupPlan?.assertCurrent();
            return local.budgets.raiseCost(root);
          },
          ...(groupPlan ? { inserted: groupPlan.inserted } : {}),
        }
      : {}),
  };
  return retryDmRun(service, { botId, conversationId, failedRunId: run.id }, plan);
}

/** A run the budget stopped (the ledger's reason is checked by the caller). */
function budgetStoppedRun(run: { status: string; errorCode?: string | null }) {
  return run.status === "error" && run.errorCode === "budget_exhausted";
}

/**
 * The interrupted run's request when it never reached the model (no session recorded), as
 * reference material; the session already holds it otherwise.
 */
function savedGoal(
  service: GroupOrchestrationPort,
  run: { userMessageId: string | null; conversationId: string },
) {
  const message = run.userMessageId
    ? new MessagesRepo(service.deps.db).get(run.userMessageId)
    : undefined;
  return message?.role === "user" &&
    message.conversationId === run.conversationId &&
    message.content.length <= 16_000
    ? savedGoalPrompt(service.deps.redactor.redact(message.content))
    : "";
}
