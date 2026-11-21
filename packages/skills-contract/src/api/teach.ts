import {
  IdSchema,
  RecordingSchema,
  RecordingStatusSchema,
  SkillDraftSchema,
  SkillSchema,
  TEACH_MAX_MS,
  TEACH_MAX_STEPS,
  TeachStepIndexSchema,
  TeachStepKindSchema,
  TeachStepTargetSchema,
  ThumbnailContentSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const ok = z.strictObject({ ok: z.literal(true) });
const recordingId = z.strictObject({ recordingId: IdSchema });
export const TeachMethods = {
  // Records only the Bot browser, so the spec's `apps` argument is not part of the contract.
  // `url` is the page the user starts from (typed by the user, so not a Bot site request). Without
  // it, the page re-attaches to the Bot's active recording; with it, a Bot that still has an
  // unfinished recording (maybe in another window) is refused with `teach_unfinished` (busy).
  "teach.start": {
    params: z.strictObject({ botId: IdSchema, url: z.string().trim().min(1).max(2048).optional() }),
    result: RecordingSchema,
  },
  // The Bot's one unfinished recording (recording, review or drafted) the page offers to resume.
  "teach.current": {
    params: z.strictObject({ botId: IdSchema }),
    result: RecordingSchema.nullable(),
  },
  "teach.stop": { params: recordingId, result: RecordingSchema },
  // Nothing is recorded while paused (signing in during the recording).
  "teach.pause": {
    params: recordingId.extend({ paused: z.boolean() }),
    result: z.strictObject({ paused: z.boolean() }),
  },
  "teach.review": { params: recordingId, result: RecordingSchema },
  "teach.thumbnail": {
    params: recordingId.extend({ index: TeachStepIndexSchema }),
    result: ThumbnailContentSchema,
  },
  // Only the kept steps reach the model, after the user reviewed them.
  "teach.draft": {
    params: recordingId.extend({
      keep: z
        .array(TeachStepIndexSchema)
        .min(1)
        .max(TEACH_MAX_STEPS)
        .refine((v) => new Set(v).size === v.length, "Duplicate step"),
    }),
    result: z.strictObject({ draft: SkillDraftSchema }),
  },
  "teach.trial": {
    params: z.strictObject({ botId: IdSchema, draft: SkillDraftSchema }),
    // The trial is an ordinary chat run in a new topic of the Bot, so approvals show up there.
    result: z.strictObject({ runId: IdSchema, topicId: IdSchema.optional() }),
  },
  "teach.save": {
    params: z.strictObject({ botId: IdSchema, draft: SkillDraftSchema }),
    result: SkillSchema,
  },
  "teach.discard": { params: recordingId, result: ok },
} as const;
export const TeachEvents = {
  "teach.progress": z.strictObject({
    recordingId: IdSchema,
    botId: IdSchema,
    status: RecordingStatusSchema,
    elapsedMs: z.number().int().min(0).max(TEACH_MAX_MS),
    maxMs: z.literal(TEACH_MAX_MS),
    stepCount: z.number().int().min(0).max(TEACH_MAX_STEPS),
    paused: z.boolean().optional(),
    lastStep: z
      .strictObject({ kind: TeachStepKindSchema, target: TeachStepTargetSchema })
      .optional(),
  }),
} as const;
