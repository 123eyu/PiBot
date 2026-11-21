import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

export const FileCheckpointStateSchema = z.enum(["available", "partial", "expired"]);
export const FileCheckpointItemSchema = z.strictObject({
  id: IdSchema,
  path: z.string().min(1).max(4096),
  kind: z.enum(["add", "modify", "delete", "command"]),
  restorable: z.boolean(),
  reason: z.enum(["snapshot_missing", "command", "unsafe_path", "quota"]).nullable(),
});
export const FileCheckpointSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  runId: IdSchema,
  root: z.string().max(4096),
  state: FileCheckpointStateSchema,
  version: z.number().int().positive().safe(),
  createdAt: z.iso.datetime(),
  items: z.array(FileCheckpointItemSchema).max(500),
  truncated: z.boolean(),
});
export const FileRestoreSchema = z.strictObject({
  id: IdSchema,
  checkpointId: IdSchema,
  state: z.enum(["intent", "running", "done", "conflict", "interrupted"]),
  /** Original inodes are retained here, including a file changed through an already-open fd. */
  recoveryPath: z.string().max(4096),
  items: z
    .array(
      z.strictObject({
        itemId: IdSchema,
        state: z.enum(["pending", "restored", "conflict", "interrupted"]),
        reason: z
          .enum(["file_changed", "unsafe_path", "recovery_interrupted", "file_in_use"])
          .nullable()
          .optional(),
      }),
    )
    .max(500),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type FileCheckpoint = z.infer<typeof FileCheckpointSchema>;
export type FileRestore = z.infer<typeof FileRestoreSchema>;
