// One bounded redistribution request prevents the coordinator from routinely doing every role's work.
import type { Bot, GroupPlan } from "@pibot/protocol-base";
import { canVerifyKind, isImplementationRole, verificationKind } from "@pibot/teams-contract";

export function needsDelegation(plan: GroupPlan, members: readonly Bot[], coordinator: string) {
  const work = plan.steps.filter(
    (step) => !step.acceptance.some((item) => item.check === "verdict"),
  );
  const own = work.filter((step) => {
    const owner = step.owner;
    return "botId" in owner
      ? owner.botId === coordinator
      : members.find((bot) => bot.role?.id === owner.role)?.id === coordinator;
  });
  return (
    own.length > work.length / 2 &&
    own.some((step) =>
      members.some((bot) => {
        if (bot.id === coordinator || bot.archivedAt || bot.category === "image") return false;
        if (!step.deliverables.length || !bot.role) return true;
        return step.deliverables.some((file) => {
          const kind = verificationKind(file.path);
          return kind === "code"
            ? isImplementationRole(bot.role?.id)
            : canVerifyKind(bot.role?.id, kind);
        });
      }),
    )
  );
}
