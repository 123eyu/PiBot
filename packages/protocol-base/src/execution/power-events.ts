import { z } from "zod";
import { CanonicalTimeSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";

/** Host power facts persisted by the kernel; routine policy may consume them but does not own them. */
export const PowerEventKindSchema = z.enum([
  "suspend",
  "resume",
  "start",
  "on-ac",
  "on-battery",
  "lock-screen",
  "unlock-screen",
]);
export const PowerEventSchema = z.strictObject({
  id: IdSchema,
  kind: PowerEventKindSchema,
  at: CanonicalTimeSchema,
});
export type PowerEvent = z.infer<typeof PowerEventSchema>;
