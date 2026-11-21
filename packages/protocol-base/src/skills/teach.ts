import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { AbsolutePathSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import { DomainSchema } from "../permissions/settings.ts";
import { SkillDocumentBaseSchema } from "./skills.ts";

const time = z.iso.datetime();

export const TEACH_MAX_MS = 15 * 60 * 1000;
export const TEACH_MAX_STEPS = 500;
export const TeachStepIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(TEACH_MAX_STEPS - 1);
export const TeachStepKindSchema = z.enum([
  "navigate",
  "click",
  "type",
  "select",
  "submit",
  "download",
]);
export const TeachStepTargetSchema = z.string().max(500).refine(plainText);
/**
 * One recorded action in the Bot's browser. Secret fields
 * (password, one-time code, card data) keep only the fact that something was typed.
 */
export const TeachStepSchema = z
  .strictObject({
    index: TeachStepIndexSchema,
    kind: TeachStepKindSchema,
    url: z.string().max(2048).refine(plainText),
    target: TeachStepTargetSchema,
    value: z.string().max(2000).optional(),
    secret: z.boolean(),
    hasThumbnail: z.boolean(),
    at: time,
  })
  .refine((step) => !step.secret || step.value === undefined, "Secret value recorded");
export const RecordingStatusSchema = z.enum([
  "recording",
  "review",
  "drafted",
  "saved",
  "discarded",
  "failed",
]);
export const RecordingSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  status: RecordingStatusSchema,
  startedAt: time,
  endedAt: time.nullable(),
  steps: z
    .array(TeachStepSchema)
    .max(TEACH_MAX_STEPS)
    .refine((steps) => steps.every((step, i) => step.index === i), "Step order"),
});
/** Draft shown in step 2 ("整理"): the skill plus the permissions and trigger it will need. */
export const SkillDraftSchema = SkillDocumentBaseSchema.extend({
  recordingId: IdSchema.nullable(),
  permissions: z.strictObject({
    domains: z.array(DomainSchema).max(50),
    writePaths: z.array(AbsolutePathSchema).max(50),
    sendTo: z.array(z.string().trim().min(1).max(200).refine(plainText)).max(50),
  }),
  trigger: z.enum(["chat", "routine"]),
});

export type TeachStep = z.infer<typeof TeachStepSchema>;
export type RecordingStatus = z.infer<typeof RecordingStatusSchema>;
export type Recording = z.infer<typeof RecordingSchema>;
export type SkillDraft = z.output<typeof SkillDraftSchema>;
