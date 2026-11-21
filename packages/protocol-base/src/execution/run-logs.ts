import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

const _text = z.string().min(1);
const count = z.number().int().nonnegative().safe();
const ok = z.strictObject({ ok: z.literal(true) });
// A run holds one log per command, so the step's tool call selects the file. Old callers omit it
// and keep the run-level behaviour: readable only while the run has a single log.
const toolCallId = z.string().min(1).max(300).optional();
export const RunLogMethods = {
  // Offsets address UTF-8 bytes of the currently redacted view, never file paths.
  "runs.readLog": {
    params: z.strictObject({
      runId: IdSchema,
      toolCallId,
      offset: count.max(5 * 1024 * 1024).optional(),
      limit: count
        .positive()
        .max(256 * 1024)
        .optional(),
    }),
    result: z.strictObject({
      text: z.string().max(256 * 1024),
      offset: count,
      nextOffset: count.nullable(),
      totalBytes: count,
      truncated: z.boolean(),
    }),
  },
  "runs.revealLog": { params: z.strictObject({ runId: IdSchema, toolCallId }), result: ok },
  "runs.openLog": { params: z.strictObject({ runId: IdSchema, toolCallId }), result: ok },
} as const;
