import { z } from "zod";
import { BrowserPageSchema, HostBrowserTabIdSchema } from "../browser/host.ts";
import { IdSchema } from "../core/ids.ts";
import { CredentialSchema, LoginFillResultSchema } from "./credentials.ts";

/** Private trusted toolbar IPC; sender binding supplies the Bot/profile, never page input. */
export const TakeoverToolbarStateSchema = z.strictObject({
  botId: IdSchema,
  botName: z.string().max(200),
  page: BrowserPageSchema.nullable(),
  documentId: IdSchema.nullable(),
  accounts: z.array(CredentialSchema).max(200),
  language: z.enum(["zh", "en"]),
  theme: z.enum(["light", "dark"]),
});
export const TakeoverToolbarMethods = {
  getState: {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: TakeoverToolbarStateSchema,
  },
  fill: {
    params: z.strictObject({
      credentialId: IdSchema,
      tab: HostBrowserTabIdSchema,
      documentId: IdSchema,
    }),
    result: LoginFillResultSchema,
  },
  handBack: {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;
export const TakeoverToolbarRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("getState"), params: TakeoverToolbarMethods.getState.params }),
  z.strictObject({ method: z.literal("fill"), params: TakeoverToolbarMethods.fill.params }),
  z.strictObject({ method: z.literal("handBack"), params: TakeoverToolbarMethods.handBack.params }),
]);
export type TakeoverToolbarState = z.infer<typeof TakeoverToolbarStateSchema>;
