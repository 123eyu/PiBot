import {
  BrowserPageSchema,
  CredentialCaptureSchema,
  CredentialSaveSchema,
  CredentialSchema,
  CredentialStatusSchema,
  HostBrowserTabIdSchema,
  IdSchema,
  LoginFillResultSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const ok = z.strictObject({ ok: z.literal(true) });
const label = CredentialSchema.shape.label;
export const CredentialMethods = {
  "credentials.takeoverAccounts": {
    params: z.strictObject({ botId: IdSchema, groupId: IdSchema.optional() }),
    result: z
      .strictObject({
        page: BrowserPageSchema,
        documentId: IdSchema,
        accounts: z.array(CredentialSchema).max(200),
      })
      .nullable(),
  },
  "credentials.fillForTakeover": {
    params: z.strictObject({
      botId: IdSchema,
      groupId: IdSchema.optional(),
      credentialId: IdSchema,
      tab: HostBrowserTabIdSchema,
      documentId: IdSchema,
    }),
    result: z.lazy(() => LoginFillResultSchema),
  },
  "credentials.status": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: CredentialStatusSchema,
  },
  // Ordered by site, then display name; `after` is the last id of the previous page.
  "credentials.list": {
    params: z.strictObject({
      botId: IdSchema.optional(),
      after: IdSchema.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    result: z.array(CredentialSchema).max(200),
  },
  "credentials.save": { params: CredentialSaveSchema, result: CredentialSchema },
  "credentials.delete": { params: z.strictObject({ id: IdSchema }), result: ok },
  // Asks for system authentication first (macOS Touch ID / login password). The password comes
  // back as UTF-16 code units: brain's outgoing text redaction knows it, and this authenticated
  // answer is the one place it must reach the window.
  "credentials.reveal": {
    params: z.strictObject({ id: IdSchema }),
    result: z.strictObject({
      username: z.string().max(500),
      password: z.array(z.number().int().min(0).max(0xffff)).max(1000),
    }),
  },
  "credentials.capture.get": {
    params: z.strictObject({ botId: IdSchema }),
    result: CredentialCaptureSchema.nullable(),
  },
  "credentials.capture.resolve": {
    params: z.strictObject({
      botId: IdSchema,
      captureId: IdSchema,
      save: z.boolean(),
      botIds: z.array(IdSchema).max(500).optional(),
      label: label.optional(),
    }),
    result: z.strictObject({ ok: z.literal(true), credential: CredentialSchema.nullable() }),
  },
  // The first-login card: which account (when several match) and "don't ask again".
  "credentials.login.resolve": {
    params: z.strictObject({
      approvalId: IdSchema,
      decision: z.enum(["allow", "deny"]),
      credentialId: IdSchema.optional(),
      remember: z.boolean(),
      preauthorize: z.boolean().optional(),
    }),
    result: ok,
  },
} as const;
export const CredentialEvents = {
  "credentials.changed": z.strictObject({}),
  "credentials.capture": z.strictObject({
    botId: IdSchema,
    capture: CredentialCaptureSchema.nullable(),
  }),
} as const;
