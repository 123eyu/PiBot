import { type CollaborationPort, groupWorkplace } from "@pibot/brain/orchestration-kit";
import { IdSchema, RpcError, RpcErrorCodes, type Run } from "@pibot/protocol-base";
import { BotsRepo, GroupExecutionLimitsRepo, MessagesRepo } from "@pibot/storage";
import { z } from "zod";
import { templateOf } from "./group-plan-template.ts";
import { validateGroupPlan } from "./group-plan-validation.ts";
import { PlanWorkplaceSchema } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";

const Raised = z.strictObject({ planId: IdSchema, used: z.number().int().positive().safe() });

/** A pending card has no workflow ledger or member to resume; raising must not confirm it. */
export function pendingPlanBudgetResume(
  service: GroupService,
  run: Run,
): ReturnType<NonNullable<CollaborationPort["planBudgetResume"]>> {
  if (!run.groupId || !run.cycleId) return;
  const { db, local } = service.deps;
  const messages = new MessagesRepo(db);
  const entry = service.plans.repo.forCycle(run.conversationId, run.cycleId);
  const template = templateOf(run.userMessageId ? messages.get(run.userMessageId) : undefined);
  if (
    !entry ||
    !template ||
    entry.card.originRunId !== run.id ||
    entry.card.budgetRootRunId !== run.id ||
    entry.card.groupId !== run.groupId
  )
    return;
  const reply = messages.get(run.messageId);
  const usage = reply?.usage;
  const raised = Raised.safeParse(
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? usage.groupPlanPendingBudgetRaised
      : undefined,
  );
  const ledger = local.budgets.repo.get(run.id);
  if (
    raised.success &&
    raised.data.planId === entry.card.id &&
    (ledger?.costRaises?.count ?? 0) >= raised.data.used
  )
    return { resumedRunId: run.id, assertCurrent() {}, inserted() {} };
  if (
    ledger?.exhaustedReason !== "cost" ||
    !["pending", "ready"].includes(entry.card.status) ||
    entry.card.replacesWorkflowRunId ||
    service.workflows.repo.byPlan(entry.card.id)
  )
    return;
  let preparedWorkplace: string | undefined;
  const assertCurrent = () => {
    const current = service.plans.repo.forCycle(run.conversationId, run.cycleId as string);
    const group = service.active(run.groupId as string, run.botId, run.conversationId);
    const cycle = service.cycles.get(group.id);
    const source = run.userMessageId ? messages.get(run.userMessageId) : undefined;
    const origin = service.runs.get(run.id);
    const budget = local.budgets.repo.get(run.id);
    const bots = new BotsRepo(db);
    const checked = validateGroupPlan(
      entry.card.plan,
      group.members.flatMap(({ botId }) => {
        const bot = bots.get(botId);
        return bot ? [bot] : [];
      }),
    );
    if (
      service.signal.aborted ||
      group.paused ||
      service.changing(group.id) ||
      group.coordinatorBotId !== run.botId ||
      cycle.cycleId !== run.cycleId ||
      cycle.limited ||
      origin?.status !== "error" ||
      origin.errorCode !== "budget_exhausted" ||
      origin.userMessageId !== run.userMessageId ||
      source?.role !== "user" ||
      source.conversationId !== run.conversationId ||
      JSON.stringify(templateOf(source)) !== JSON.stringify(template) ||
      current?.message.id !== entry.message.id ||
      JSON.stringify(current.card) !== JSON.stringify(entry.card) ||
      service.workflows.repo.byPlan(entry.card.id) ||
      new GroupExecutionLimitsRepo(db).get(group.id).mode !== "execute" ||
      !checked.ok ||
      JSON.stringify(checked.owners) !== JSON.stringify(entry.card.owners) ||
      budget?.exhaustedReason !== "cost" ||
      service.runs.hasRunAfter(run.id) ||
      local.toolJournal.repo.uncertainCount(run.id) ||
      (preparedWorkplace !== undefined &&
        JSON.stringify(PlanWorkplaceSchema.parse(group)) !== preparedWorkplace)
    )
      throw new RpcError(RpcErrorCodes.busy, "group_plan_budget_pending_stale");
    const resources = service.deps.chat.queue.resources();
    if (
      !resources.healthy ||
      budget.activeChildren ||
      local.budgets.repo.pendingModelRequests(run.id) ||
      resources.contexts.some((context) => {
        const active = service.runs.get(context.runId);
        return active && local.tasks.budgetRoot(active) === run.id;
      })
    )
      throw new RpcError(RpcErrorCodes.busy, "group_plan_budget_resume_draining");
    return group;
  };
  return {
    budgetOnly: {
      async prepare(signal) {
        const group = assertCurrent();
        const place = await groupWorkplace(local, run.botId, group, signal);
        signal.throwIfAborted();
        if (entry.card.delivery && entry.card.delivery.workspaceRoot !== place.cwd)
          throw new RpcError(RpcErrorCodes.invalidParams, "group_plan_workplace_changed");
        preparedWorkplace = JSON.stringify(PlanWorkplaceSchema.parse(group));
      },
    },
    assertCurrent,
    inserted() {
      const current = messages.get(run.messageId);
      const metadata = current?.usage;
      messages.update(run.messageId, {
        usage: {
          ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
          groupPlanPendingBudgetRaised: Raised.parse({
            planId: entry.card.id,
            used: local.budgets.repo.get(run.id)?.costRaises?.count,
          }),
        },
      });
    },
  };
}
