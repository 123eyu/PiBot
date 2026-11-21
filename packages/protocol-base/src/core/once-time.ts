import { z } from "zod";
import { CanonicalTimeSchema, TimezoneSchema } from "./boundaries.ts";

/** Neutral wall-clock resolution input shared by the scheduler and its callers. */
export const OnceTimeInputSchema = z.strictObject({
  localTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/),
  timezone: TimezoneSchema,
  disambiguation: z.enum(["earlier", "later"]).optional(),
});
export const OnceTimeResultSchema = z.strictObject({
  status: z.enum(["resolved", "ambiguous", "nonexistent", "invalid"]),
  at: CanonicalTimeSchema.nullable(),
  candidates: z
    .array(z.strictObject({ at: CanonicalTimeSchema, offsetMinutes: z.number() }))
    .max(2),
});
export type OnceTimeInput = z.infer<typeof OnceTimeInputSchema>;
export type OnceTimeResult = z.infer<typeof OnceTimeResultSchema>;
