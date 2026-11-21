import { type ExecutionLimits, ExecutionLimitsSchema } from "@pibot/protocol";

export const budgetFields = [
  "toolCalls",
  "modelRequests",
  "activeSeconds",
  "childConcurrency",
  "childTasks",
  "childDepth",
  "tokens",
] as const;
export type BudgetValues = Record<(typeof budgetFields)[number], string>;
export function budgetValues(limits: ExecutionLimits): BudgetValues {
  return Object.fromEntries(
    budgetFields.map((field) => [
      field,
      String(field === "activeSeconds" ? limits[field] / 60 : limits[field]),
    ]),
  ) as BudgetValues;
}
export function parseBudgetValues(values: BudgetValues, cost: string) {
  return ExecutionLimitsSchema.safeParse({
    ...Object.fromEntries(
      budgetFields.map((field) => [
        field,
        values[field].trim()
          ? Number(values[field]) * (field === "activeSeconds" ? 60 : 1)
          : Number.NaN,
      ]),
    ),
    costUsd: cost.trim() ? Number(cost) : null,
  });
}
export function budgetRange(field: (typeof budgetFields)[number]) {
  const schema = ExecutionLimitsSchema.shape[field],
    factor = field === "activeSeconds" ? 60 : 1;
  return { min: (schema.minValue ?? 0) / factor, max: (schema.maxValue ?? 0) / factor };
}
