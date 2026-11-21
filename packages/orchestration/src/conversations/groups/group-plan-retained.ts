// Completed step definitions come from the archive so replan prose cannot replay side effects.
import { GroupPlanSchema } from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord, GroupWorkflowStepRecord } from "@pibot/storage";

type Raw = Record<string, unknown>;
const object = (value: unknown): value is Raw =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function retainCompletedPlan(
  value: unknown,
  record: GroupWorkflowRunRecord | undefined,
  states: readonly GroupWorkflowStepRecord[],
  // A verdict repair only adds the fix and the recheck; the steps still waiting behind the failed
  // check (a review, a summary) carry on unchanged even when the coordinator leaves them out.
  options: { keepWaiting?: boolean } = {},
): { value: unknown; notes: string[] } {
  if (!record || !object(value) || !Array.isArray(value.steps)) return { value, notes: [] };
  const submittedSteps = value.steps;
  const original = GroupPlanSchema.parse(
    (record.workflow as { dynamicPlan?: unknown }).dynamicPlan,
  );
  const completed = states.filter((step) => step.status === "passed" || step.status === "skipped");
  const ids = new Set(completed.map((step) => step.stepId));
  const retained = original.steps
    .filter((step) => ids.has(step.id))
    .map((step) => ({
      ...step,
      owner: { botId: completed.find((state) => state.stepId === step.id)?.ownerBotId },
    }));
  const submittedIds = new Set(
    submittedSteps.filter(object).map((item) => String((item as Raw).id ?? "")),
  );
  const waiting = options.keepWaiting
    ? original.steps
        .filter((step) => {
          const state = states.find((item) => item.stepId === step.id);
          return (
            (state?.status === "waiting" || state?.status === "ready") && !submittedIds.has(step.id)
          );
        })
        .map((step) => ({
          ...step,
          owner: { botId: states.find((state) => state.stepId === step.id)?.ownerBotId },
        }))
    : [];
  const changed = retained.some((step) => {
    const submitted = submittedSteps.find((item) => object(item) && item.id === step.id);
    return !submitted || JSON.stringify(submitted) !== JSON.stringify(step);
  });
  return {
    value: {
      ...value,
      steps: [
        ...retained,
        ...submittedSteps.filter((step) => !object(step) || !ids.has(String(step.id))),
        ...waiting,
      ],
    },
    notes:
      changed || waiting.length
        ? [
            "程序已从存档保留已完成/已跳过步骤；重交差异使用存档版本 / Completed and skipped steps were retained from the archive; resubmitted differences use the archived definitions.",
          ]
        : [],
  };
}
