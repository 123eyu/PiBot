import {
  BotPermissionOverridesSchema,
  CanonicalTimeSchema,
  IdSchema,
  PermissionsSettingsSchema,
  SessionFileSchema,
  WorkspaceSnapshotSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

// Trusted adapter assertions, never proof manufactured by a renderer or by SQLite.
export const RoutineDrainSchema = z.strictObject({
  aborted: z.literal(true),
  idle: z.literal(true),
  jsonlDrained: z.literal(true),
  at: CanonicalTimeSchema,
});
export const RoutinePermissionSnapshotSchema = z.strictObject({
  global: PermissionsSettingsSchema,
  botOverrides: BotPermissionOverridesSchema,
  effective: PermissionsSettingsSchema,
  isolationAvailable: z.boolean(),
});
export const RoutineWaitCheckpointSchema = z.strictObject({
  approvalId: IdSchema,
  operationHash: z.string().regex(/^[a-f0-9]{64}$/),
  permissionRevision: z.number().int().nonnegative().safe(),
  permissionSnapshot: RoutinePermissionSnapshotSchema,
  workspaceSnapshot: WorkspaceSnapshotSchema,
  botId: IdSchema,
  routineRunId: IdSchema,
  runId: IdSchema,
  conversationId: IdSchema,
  messageId: IdSchema,
  sessionFile: SessionFileSchema,
  attempt: z.number().int().positive().safe(),
  operationState: z.literal("unexecuted"),
  drain: RoutineDrainSchema.nullable(),
});
// T3/T6 revalidate managed session identity and current policy before calling the repository.
export const RoutineResumeVerificationSchema = RoutineWaitCheckpointSchema.omit({
  drain: true,
  attempt: true,
  operationState: true,
}).extend({ managedSessionVerified: z.literal(true) });
export type RoutineWaitCheckpoint = z.infer<typeof RoutineWaitCheckpointSchema>;
export type RoutineResumeVerification = z.infer<typeof RoutineResumeVerificationSchema>;
