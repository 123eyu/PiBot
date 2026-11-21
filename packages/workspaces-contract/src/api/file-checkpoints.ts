import {
  ChangesTargetSchema,
  FileCheckpointSchema,
  FileRestoreSchema,
  IdSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const target = ChangesTargetSchema;
export const FileCheckpointMethods = {
  "changes.checkpoints.forRun": {
    params: z.strictObject({ target, runId: IdSchema }),
    result: z
      .array(
        FileCheckpointSchema.omit({ items: true }).extend({
          rootId: z.union([z.literal("home"), IdSchema]),
        }),
      )
      .max(5),
  },
  "changes.checkpoints.restores": {
    params: z.strictObject({
      target,
      id: IdSchema,
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    result: z.strictObject({
      items: z.array(FileRestoreSchema).max(20),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "changes.checkpoints.resume": {
    params: z.strictObject({ target, restoreId: IdSchema }),
    result: FileRestoreSchema,
  },
  "changes.checkpoints.create": {
    params: z.strictObject({ target, runId: IdSchema }),
    result: FileCheckpointSchema,
  },
  "changes.checkpoints.list": {
    params: z.strictObject({
      target,
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    result: z.strictObject({
      items: z.array(FileCheckpointSchema.omit({ items: true })).max(50),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "changes.checkpoints.get": {
    params: z.strictObject({ target, id: IdSchema }),
    result: FileCheckpointSchema,
  },
  "changes.checkpoints.restore": {
    params: z.strictObject({
      target,
      id: IdSchema,
      requestId: IdSchema,
      expectedVersion: z.number().int().positive().safe(),
      itemIds: z.array(IdSchema).min(1).max(500),
    }),
    result: FileRestoreSchema,
  },
  /** Read-only reconciliation of the retained journal; never silently resumes writes. */
  "changes.checkpoints.recover": {
    params: z.strictObject({ target, restoreId: IdSchema }),
    result: FileRestoreSchema,
  },
} as const;
