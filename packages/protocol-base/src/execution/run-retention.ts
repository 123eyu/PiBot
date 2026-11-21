import { z } from "zod";

const count = z.number().int().nonnegative().safe();

export const RunRetentionResultSchema = z.strictObject({
  runs: count,
  events: count,
  executions: count,
  sessionFiles: count,
  resultFiles: count,
});
export type RunRetentionResult = z.infer<typeof RunRetentionResultSchema>;

export const RunRetentionMethods = {
  "runs.cleanup": {
    params: z.strictObject({
      olderThanDays: z.number().int().min(1).max(36_500),
      confirmed: z.literal(true),
    }),
    result: RunRetentionResultSchema,
  },
} as const;
