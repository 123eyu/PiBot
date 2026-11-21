import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

export const CheckpointCaptureReasonSchema = z.enum([
  "checkpoint_bytes_quota",
  "project_items_quota",
  "snapshot_unavailable",
  "authority_changed",
  "capture_interrupted",
  "capture_failed",
]);
export const CheckpointCaptureSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("retained"), checkpointId: IdSchema, reason: z.null() }),
  z.strictObject({
    state: z.literal("skipped"),
    checkpointId: z.null(),
    reason: CheckpointCaptureReasonSchema,
  }),
]);
export type CheckpointCapture = z.infer<typeof CheckpointCaptureSchema>;
export type CheckpointCaptureReason = z.infer<typeof CheckpointCaptureReasonSchema>;
