import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { SequenceSchema } from "../core/sequence.ts";

const text = z.string().min(1).max(200);

/** Public metadata projection of an append-only run fact. Raw payloads stay inside the brain. */
export const RunEventSummarySchema = z
  .strictObject({
    seq: SequenceSchema.positive(),
    runId: IdSchema,
    conversationId: IdSchema,
    kind: z.string().min(1).max(100),
    at: z.iso.datetime(),
    outcome: z
      .strictObject({
        status: text,
        stopReason: text.nullable(),
        errorCode: text.nullable(),
      })
      .optional(),
  })
  .refine(
    (event) =>
      ["run.finished", "run.interrupted", "run.sealed"].includes(event.kind) === !!event.outcome,
    "Outcome must match a terminal run event",
  );

export const RunEventPageSchema = z.strictObject({
  events: z.array(RunEventSummarySchema).max(200),
  nextSeq: SequenceSchema,
  /** The page reached the current tail after the durable `run.sealed` watermark. */
  settled: z.boolean(),
});

export const RunEventMethods = {
  "runs.events": {
    params: z.strictObject({
      runId: IdSchema,
      afterSeq: SequenceSchema,
      limit: z.number().int().positive().max(200).optional(),
    }),
    result: RunEventPageSchema,
  },
} as const;

export type RunEventSummary = z.infer<typeof RunEventSummarySchema>;
export type RunEventPage = z.infer<typeof RunEventPageSchema>;
