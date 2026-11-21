import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { RunSchema } from "../execution/runs.ts";
import { CheckpointCaptureSchema } from "../workspace/checkpoint-capture.ts";

/**
 * Stop reason of a run that a restart cut off while it was running. The run row is
 * `aborted` with this stop reason, and its reply bubble is `aborted` with
 * `usage.stopReason === RUN_INTERRUPTED`: that pair is what the UI shows as "interrupted · resume".
 */
export const RUN_INTERRUPTED = "interrupted";

/** Whether `runs.resume` may continue this run (the UI still asks the brain; this is the hint). */
export function interruptedRun(run: { status: string; stopReason?: string | null }) {
  return run.status === "aborted" && run.stopReason === RUN_INTERRUPTED;
}

/** Recovery is a new user-requested run, never a replay of saved tool instructions. */
export function recoverableChatRun(run: { status: string; stopReason?: string | null }) {
  return (
    run.status === "error" ||
    run.status === "aborted" ||
    (run.status === "done" && run.stopReason === "length")
  );
}

export const ChatRecoverySchema = z.strictObject({
  run: RunSchema.pick({
    id: true,
    status: true,
    errorCode: true,
    finishedAt: true,
  }),
  task: z
    .strictObject({
      id: IdSchema,
      title: z.string().max(2000),
      status: z.enum(["open", "done", "cancelled"]),
    })
    .nullable(),
  session: z.strictObject({
    state: z.enum(["available", "missing", "unavailable", "busy"]),
    entryCount: z.number().int().nonnegative(),
    checkpoint: z
      .strictObject({
        id: z.string().min(1).max(128),
        createdAt: z.iso.datetime(),
        tokensBefore: z.number().finite().nonnegative(),
      })
      .nullable(),
  }),
  fileCheckpoint: CheckpointCaptureSchema.nullable(),
  continuation: z.enum(["ready", "busy", "newer_run", "unavailable", "already_requested"]),
});
export const ChatRecoveryMethods = {
  "chat.recovery": {
    params: z.strictObject({ botId: IdSchema, conversationId: IdSchema, runId: IdSchema }),
    result: ChatRecoverySchema,
  },
} as const;
export type ChatRecovery = z.infer<typeof ChatRecoverySchema>;
