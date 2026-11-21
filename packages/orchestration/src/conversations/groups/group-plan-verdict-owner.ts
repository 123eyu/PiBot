import type { Bot, GroupPlan } from "@pibot/protocol-base";
import type { PlanIssue } from "./group-plan-validation.ts";

export function verdictOwnerIssues(
  plan: GroupPlan,
  members: readonly Bot[],
  owners: readonly { stepId: string; botId: string }[],
  implementationAuthorBotId?: string | readonly string[],
): PlanIssue[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const assigned = new Map(owners.map((owner) => [owner.stepId, owner.botId]));
  return plan.steps.flatMap((step, index) => {
    if (!step.acceptance.some((item) => item.check === "verdict")) return [];
    const botId = assigned.get(step.id);
    const bot = members.find((member) => member.id === botId);
    const seen = new Set<string>();
    const authored = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      const upstream = byId.get(id);
      return (
        !!upstream &&
        ((!upstream.acceptance.some((item) => item.check === "verdict") &&
          assigned.get(id) === botId) ||
          upstream.dependsOn.some(authored))
      );
    };
    if (
      bot &&
      bot.category !== "image" &&
      !(
        typeof implementationAuthorBotId === "string"
          ? [implementationAuthorBotId]
          : (implementationAuthorBotId ?? [])
      ).includes(botId ?? "") &&
      !step.dependsOn.some(authored)
    )
      return [];
    return [
      {
        code: "verdict_owner_invalid",
        path: ["steps", index, "owner"],
        message:
          "成果核对须交给独立成员，不能验证自己的成果 / Assign verdict checks to an independent member, never the artifact author",
      },
    ];
  });
}
