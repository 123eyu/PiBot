import { AcceptanceCheckSchema } from "@pibot/protocol-base";
import type { PlanIssue } from "./group-plan-validation.ts";

type Raw = Record<string, unknown>;
const object = (value: unknown): Raw | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;
/** Method entries are prepended; diagnostics must point back to what the model actually wrote. */
export function originalPlanIssues(
  issues: PlanIssue[],
  original: unknown,
  expanded: unknown,
): PlanIssue[] {
  const ownSteps = object(original)?.steps;
  const expandedSteps = object(expanded)?.steps;
  return issues.map((issue) => {
    const path = [...issue.path];
    const [root, stepIndex, field, itemIndex] = path;
    if (
      root !== "steps" ||
      typeof stepIndex !== "number" ||
      (field !== "acceptance" && field !== "deliverables") ||
      typeof itemIndex !== "number"
    )
      return issue;
    const own = Array.isArray(ownSteps) ? object(ownSteps[stepIndex])?.[field] : undefined;
    const merged = Array.isArray(expandedSteps)
      ? object(expandedSteps[stepIndex])?.[field]
      : undefined;
    const item = Array.isArray(merged) ? object(merged[itemIndex]) : undefined;
    const index = Array.isArray(own)
      ? own.findIndex((entry) => object(entry)?.id === item?.id)
      : -1;
    if (index < 0) return { ...issue, path: ["steps", stepIndex, "method"] };
    path[3] = index;
    const kind = AcceptanceCheckSchema.safeParse(item?.check);
    return { ...issue, path, ...(kind.success ? { kind: kind.data } : {}) };
  });
}
