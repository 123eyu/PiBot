import { abortable, skillContract, type ToolRunContext } from "@pibot/brain/orchestration-kit";
import type { SkillContract } from "@pibot/protocol-base";
import { BotsRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/** Bounded so a large group never turns the end-of-run check into a long skill scan. */
const MAX_METHODS = 24;

export type SoloDeliveryMethod = Pick<SkillContract, "deliverables" | "acceptance">;

/**
 * For solo work (2026-11-11 real run: product-team went solo and missed the requested
 * names and sections). Only the coordinator's own main-topic run of a cycle with no plan and no
 * delegation counts as solo; its contract is the request's named outputs plus the members' method
 * contracts, matched later by file name. Undefined means "not solo", never "no contract".
 */
export async function soloDeliveryMethods(
  service: GroupService,
  context: ToolRunContext,
  signal: AbortSignal,
): Promise<{ methods: SoloDeliveryMethod[] } | undefined> {
  if (
    !context.groupId ||
    !context.conversationId ||
    context.threadId ||
    context.executionTaskId ||
    context.routineRunId
  )
    return undefined;
  const run = service.runs.get(context.runId);
  const group = service.groups.get(context.groupId);
  if (
    !run?.cycleId ||
    !group ||
    run.groupId !== group.id ||
    run.botId !== context.botId ||
    run.botId !== group.coordinatorBotId ||
    run.conversationId !== context.conversationId ||
    run.conversationId !== group.conversationId ||
    (run.kind !== "chat" && run.kind !== "wake")
  )
    return undefined;
  const summary = service.workflows.repo.executionSummary(
    group.id,
    run.conversationId,
    run.cycleId,
  );
  if (summary.plans || summary.delegated) return undefined;
  if (service.plans.repo.forCycle(run.conversationId, run.cycleId)) return undefined;
  const skills = service.deps.local.skills;
  const methods: SoloDeliveryMethod[] = [];
  if (!skills) return { methods };
  const bots = new BotsRepo(service.deps.db);
  for (const member of group.members) {
    const bot = bots.get(member.botId);
    if (!bot || bot.archivedAt) continue;
    for (const key of await skills.planMethodKeys(bot.id, group.id, signal)) {
      if (methods.length >= MAX_METHODS) return { methods };
      try {
        const skill = await abortable(skills.findWorkflow(bot.id, key, group.id), signal);
        const contract = skill ? skillContract(skill.document).contract : undefined;
        if (contract)
          methods.push({ deliverables: contract.deliverables, acceptance: contract.acceptance });
      } catch (error) {
        // An unreadable method only drops its checks; cancellation still propagates.
        if (signal.aborted) throw error;
      }
    }
  }
  return { methods };
}
