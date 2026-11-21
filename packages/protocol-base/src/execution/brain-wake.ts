import { z } from "zod";
import { AbsolutePathSchema, CanonicalTimeSchema } from "../core/boundaries.ts";
import { FilenamePatternSchema } from "../core/filename-pattern.ts";
import { IdSchema } from "../core/ids.ts";

export const BrainWakeReasonSchema = z.enum(["timer", "folder", "gui", "power", "host", "cancel"]);
export const WakeFolderSchema = z.strictObject({
  triggerId: IdSchema,
  routineId: IdSchema,
  path: AbsolutePathSchema,
  events: z.enum(["new", "new_and_changed"]),
  pattern: FilenamePatternSchema,
  recursive: z.boolean(),
  cooldownMin: z.number().int().min(1).max(60),
  // Canonical file identity parts (execution `fileIdentity`): decimal, or 0x-hex above 2^53.
  dev: z.string().regex(/^(?:\d+|0x[0-9a-f]+)$/),
  ino: z.string().regex(/^(?:\d+|0x[0-9a-f]+)$/),
});
export const WakePlanSchema = z.strictObject({
  epoch: IdSchema,
  revision: z.number().int().nonnegative().safe(),
  builtAt: CanonicalTimeSchema,
  // nextAt already includes the two-minute lead; checksAt does not.
  nextAt: CanonicalTimeSchema.nullable(),
  checksAt: CanonicalTimeSchema.nullable(),
  pollAt: CanonicalTimeSchema.nullable(),
  folders: z.array(WakeFolderSchema).max(64),
  polling: z.boolean(),
});
export const BrainSleepBlockerSchema = z.enum([
  "gui",
  "work",
  "requests",
  "approvals",
  "automation",
  "stopping",
  "unavailable",
  "not_idle",
  "upcoming",
  "stale",
  "budget",
]);
export const BrainIdleReportSchema = z.strictObject({
  phase: z.enum(["working", "preparing", "prepared", "committed"]),
  plan: WakePlanSchema.nullable(),
  idleSince: CanonicalTimeSchema.nullable(),
  canSleep: z.boolean(),
  blockers: z.array(BrainSleepBlockerSchema).max(16),
});
export const BrainSleepTicketSchema = z.strictObject({
  id: IdSchema,
  epoch: IdSchema,
  revision: z.number().int().nonnegative().safe(),
  expiresAt: CanonicalTimeSchema,
});
export const BrainWakeControlSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("report") }),
  z.strictObject({
    operation: z.literal("prepare"),
    epoch: IdSchema,
    revision: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({ operation: z.literal("commit"), ticket: BrainSleepTicketSchema }),
  z.strictObject({ operation: z.literal("resume"), reason: BrainWakeReasonSchema }),
]);
export const BrainWakeResultSchema = z.strictObject({
  report: BrainIdleReportSchema,
  ticket: BrainSleepTicketSchema.optional(),
  committed: z.boolean().optional(),
});
// This is a trusted utility-parent channel, never a renderer method or socket control.
export const BrainWakeRequestSchema = z.strictObject({
  type: z.literal("brain-wake-request"),
  id: IdSchema,
  control: BrainWakeControlSchema,
});
export const BrainWakeReplySchema = z.strictObject({
  type: z.literal("brain-wake-reply"),
  id: IdSchema,
  ok: z.boolean(),
  result: BrainWakeResultSchema.optional(),
});
export type WakePlan = z.infer<typeof WakePlanSchema>;
export type BrainIdleReport = z.infer<typeof BrainIdleReportSchema>;
export type BrainSleepTicket = z.infer<typeof BrainSleepTicketSchema>;
export type BrainWakeControl = z.infer<typeof BrainWakeControlSchema>;
export type BrainWakeResult = z.infer<typeof BrainWakeResultSchema>;
