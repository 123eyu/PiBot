import { BuiltinAppSchema } from "@pibot/protocol-base";
import { z } from "zod";

/** Installed applications share the built-in card contract, but cannot grant trusted host access. */
export const PortablePiBotApplicationSchema = z.strictObject({
  format: z.literal("pibot-application"),
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/),
  card: BuiltinAppSchema.omit({ id: true, supported: true, unsupportedReason: true }).extend({
    platforms: z
      .array(z.enum(["darwin", "win32", "linux"]))
      .min(1)
      .max(3),
  }),
  server: z.strictObject({
    entry: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+\.m?js$/),
    env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(4096)).default({}),
    networkDomains: z.array(z.string().min(1).max(253)).max(64).default([]),
  }),
});
export type PortablePiBotApplication = z.output<typeof PortablePiBotApplicationSchema>;
