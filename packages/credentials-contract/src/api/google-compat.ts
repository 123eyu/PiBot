import { GoogleCompatScopeSchema, IdSchema, ScopedGoogleCompatSchema } from "@pibot/protocol-base";
import { z } from "zod";
export const GoogleCompatMethods = {
  "browser.googleCompat.get": { params: GoogleCompatScopeSchema, result: ScopedGoogleCompatSchema },
  /** Applied to the Bot's open browser at once: tabs on Google reload under the new identity. */
  "browser.googleCompat.set": {
    params: z.union([
      z.strictObject({ botId: IdSchema, groupId: z.never().optional(), enabled: z.boolean() }),
      z.strictObject({ groupId: IdSchema, botId: z.never().optional(), enabled: z.boolean() }),
    ]),
    result: ScopedGoogleCompatSchema,
  },
} as const;
export const GoogleCompatEvents = {
  "browser.googleCompat.changed": ScopedGoogleCompatSchema,
} as const;
