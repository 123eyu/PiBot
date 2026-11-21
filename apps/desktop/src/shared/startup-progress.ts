import { z } from "zod";

/** Main → renderer while the first window attaches; carries identifiers only. */
export const STARTUP_PROGRESS_CHANNEL = "pibot:startup-progress";

export const StartupProgressEventSchema = z.strictObject({
  lifecycle: z.enum(["starting", "ready", "stopping", "stopped", "failed"]),
  /** The phase the owner's last progress beat named; null until the brain reports one. */
  phase: z.string().min(1).max(64).nullable(),
});
export type StartupProgressEvent = z.infer<typeof StartupProgressEventSchema>;
