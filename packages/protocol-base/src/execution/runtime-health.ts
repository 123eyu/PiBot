import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

const _botId = z.strictObject({ botId: IdSchema });
const noParams = z.union([z.undefined(), z.strictObject({})]);
/**
 * A run or the interactive client could not be drained, so the Bot(s) stay busy until
 * Pi Bot restarts. `healthy` and `reason` travel together; `botIds` is empty for a global failure.
 */
export const RuntimeHealthSchema = z
  .strictObject({
    healthy: z.boolean(),
    reason: z.enum(["run_drain_failed", "interactive_drain_failed"]).nullable(),
    botIds: z.array(IdSchema).max(128),
  })
  .refine((value) => value.healthy === (value.reason === null));
export type RuntimeHealth = z.infer<typeof RuntimeHealthSchema>;
export const RuntimeMethods = {
  // The UI pulls the current health once on (re)connect so a missed event is not final.
  "runtime.health.get": { params: noParams, result: RuntimeHealthSchema },
  // A user-confirmed release of the sessions whose drain failed. `confirmed` is a
  // literal so no caller can ask for it implicitly; without `botId` it targets the client-wide
  // interactive drain. The result is the health after the attempt, which may still be unhealthy.
  "runtime.forceRelease": {
    params: z.strictObject({ botId: IdSchema.optional(), confirmed: z.literal(true) }),
    result: RuntimeHealthSchema,
  },
} as const;
export const RuntimeEvents = {
  /** Authoritative snapshot, including parked approvals, deduplicated by run ID. */
  "runtime.activeRuns": z.strictObject({ count: z.number().int().nonnegative().safe() }),
  // A drain failure is sticky; `botIds` names the Bots whose sessions stayed open.
  "runtime.health": RuntimeHealthSchema,
} as const;
