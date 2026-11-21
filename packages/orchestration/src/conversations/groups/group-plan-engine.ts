import { redactValue } from "@pibot/brain/orchestration-kit";
import {
  GroupExecutionPlanSchema,
  GroupVerificationSchema,
  groupPlanNeedsConfirmation,
  RpcError,
} from "@pibot/protocol-base";
import { BotsRepo, GroupExecutionLimitsRepo } from "@pibot/storage";
import { planConfirmationRequired } from "./group-plan-confirmation.ts";
import { assertRelaxationConfirmation } from "./group-plan-relaxations.ts";
import { validateGroupPlan } from "./group-plan-validation.ts";
import type { GroupPlanEngine } from "./group-plans.ts";
import type { GroupService } from "./group-service.ts";
import {
  implementationAuthors,
  initialVerification,
  verificationFacts,
} from "./group-verification-facts.ts";
import { completedVerificationFacts } from "./group-verification-finished.ts";

/** Converts a validated card without weakening its identity, owners or per-step semantics. */
export function createGroupPlanEngine(service: GroupService): GroupPlanEngine {
  return {
    async admitted(planId, signal) {
      signal.throwIfAborted();
      return !!service.workflows.repo.byPlan(planId);
    },
    async start({ card, conversationId }, signal) {
      signal.throwIfAborted();
      const existing = service.workflows.repo.byPlan(card.id);
      if (existing) {
        if (existing.groupId !== card.groupId || existing.budgetRootRunId !== card.budgetRootRunId)
          throw new RpcError(-32602, "group_plan_identity_changed");
        return;
      }
      const automatic = initialVerification(card);
      if (automatic) {
        const origin = service.runs.get(card.originRunId);
        const facts = origin
          ? card.verification?.workflowRunId
            ? await completedVerificationFacts(service, card.verification.workflowRunId, signal)
            : await verificationFacts(service, origin, signal)
          : undefined;
        if (
          !facts ||
          JSON.stringify(
            GroupVerificationSchema.parse(redactValue(facts, service.deps.redactor)),
          ) !== JSON.stringify(card.verification)
        )
          throw new RpcError(-32602, "group_plan_verification_changed");
      }
      const build = () => {
        const group = service.active(card.groupId, undefined, conversationId);
        const origin = service.runs.get(card.originRunId);
        const bots = new BotsRepo(service.deps.db);
        const checked = validateGroupPlan(
          card.plan,
          group.members.flatMap(({ botId }) => {
            const bot = bots.get(botId);
            return bot ? [bot] : [];
          }),
          undefined,
          implementationAuthors(card.verification),
        );
        const ledger = service.deps.local.budgets.repo.get(card.budgetRootRunId);
        const settings = new GroupExecutionLimitsRepo(service.deps.db).get(group.id);
        if (
          (automatic && !!service.workflows.repo.activePlan(group.id, card.cycleId)) ||
          !origin ||
          (!automatic && origin.botId !== group.coordinatorBotId) ||
          (automatic &&
            (origin.status !== "done" ||
              origin.botId !== card.verification?.authorBotId ||
              !group.members.some((member) => member.botId === origin.botId) ||
              card.verification?.workspaceRevision !== (group.workspaceRevision ?? 0))) ||
          origin.groupId !== group.id ||
          (!automatic && origin.conversationId !== conversationId) ||
          origin.cycleId !== card.cycleId ||
          service.deps.local.tasks.budgetRoot(origin) !== card.budgetRootRunId ||
          service.cycles.get(group.id).cycleId !== card.cycleId ||
          service.cycles.get(group.id).limited ||
          group.paused ||
          !ledger ||
          settings.mode !== "execute" ||
          service.deps.local.budgets.repo.reason(ledger) ||
          ledger.requests >= ledger.limits.modelRequests ||
          !checked.ok ||
          JSON.stringify(checked.owners) !== JSON.stringify(card.owners)
        )
          throw new RpcError(-32602, "group_plan_admission_invalid");
        const previous = card.replacesWorkflowRunId
          ? service.workflows.progress.replacement(card)
          : undefined;
        assertRelaxationConfirmation(previous, card);
        const caps = [ledger.limits.costUsd, settings.limits.costUsd].filter(
          (cap): cap is number => cap !== null,
        );
        const cap = caps.length ? Math.min(...caps) : null;
        if (
          !card.confirmedByUser &&
          (card.disposition?.action === "split_step" ||
            groupPlanNeedsConfirmation(card.plan, cap) ||
            planConfirmationRequired(service, card.originRunId))
        )
          throw new RpcError(-32602, "group_plan_confirmation_required");
        const contract = {
          // `method` was already merged into the step's checks; the engine runs those.
          steps: card.plan.steps.map(({ method: _method, ...step }) => ({
            ...step,
            task: step.task.replace(/[\r\n\t]/g, " "),
            owner: { botId: card.owners.find((owner) => owner.stepId === step.id)?.botId },
          })),
          budget: {
            ...(cap === null ? {} : { costUsd: cap }),
            modelRequests: Math.min(ledger.limits.modelRequests, settings.limits.modelRequests),
            activeSeconds: Math.min(ledger.limits.activeSeconds, settings.limits.activeSeconds),
          },
        };
        return GroupExecutionPlanSchema.parse({
          source: { kind: "dynamic", planId: card.id, originRunId: card.originRunId },
          name: card.plan.name,
          contract,
          inputs: [],
        });
      };
      const plan = build();
      await service.workflows.startCard(
        card,
        plan,
        conversationId,
        signal,
        () => build().contract.budget,
      );
    },
  };
}
