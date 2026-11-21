import { z } from "zod";
import { BrowserPageSchema, HostBrowserTabIdSchema } from "../browser/host.ts";
import { plainText } from "../computer/apps.ts";
import { IdSchema } from "../core/ids.ts";
import { CredentialSiteSchema } from "./site.ts";

// Website accounts saved in Pi Bot and used by the Bot browser. The public shape
// never carries the username or password: the secret is one SecretCipher blob in the database,
// the renderer only sees the site, a display name and which Bots may use the record.
export * from "./site.ts";
export * from "./totp.ts";

const time = z.iso.datetime();
const label = z.string().trim().min(1).max(200).refine(plainText);
// Passwords are free text up to a sane bound; only the secret blob ever stores them.
const secretText = z.string().min(1).max(1000);
const username = z.string().trim().min(1).max(500).refine(plainText);

export const CredentialSchema = z.strictObject({
  id: IdSchema,
  site: CredentialSiteSchema,
  /** Display name of the account (default: a masked username); never the username itself. */
  label,
  note: z.string().max(1000),
  /** Bots that may see and use this record; others never get it offered. */
  botIds: z.array(IdSchema).max(500),
  hasPassword: z.boolean(),
  hasTotp: z.boolean().default(false),
  createdAt: time,
  updatedAt: time,
  lastUsedAt: time.nullable(),
});
export const CredentialStatusSchema = z.strictObject({
  /** Secure storage (safeStorage / keychain) works; saving is refused when it does not. */
  storage: z.boolean(),
  /** Viewing a saved password needs system authentication; false where that is unavailable. */
  reveal: z.boolean(),
});
export const CredentialSaveSchema = z.strictObject({
  /** Absent: create. Present: edit; omitted username / password keep the stored ones. */
  id: IdSchema.optional(),
  site: z.string().min(1).max(2048),
  label: label.optional(),
  username: username.optional(),
  password: secretText.optional(),
  /** Write only: omit to keep, null to remove; Base32 secret or otpauth://totp URI. */
  totp: z.string().trim().min(1).max(4096).nullable().optional(),
  note: z.string().max(1000).optional(),
  botIds: z.array(IdSchema).max(500),
});
/** Pending "save this account?" after a takeover; the password stays in the host. */
export const CredentialCaptureSchema = z.strictObject({
  botId: IdSchema,
  captureId: IdSchema,
  site: CredentialSiteSchema,
  /** Shown so the user knows which account they are saving; null when the form had none. */
  username: username.nullable(),
});
/**
 * Why the page script chose the account box. Fixed codes only — page text (a placeholder, a
 * label) never travels back, so the model learns what the signal was, not what the page says.
 */
export const LOGIN_FIELD_REASONS = [
  "autocomplete",
  "type",
  "inputmode",
  "name",
  "placeholder",
  "label",
  "near_password",
  "button",
  "url",
  "single_field",
] as const;
export const LoginFieldReasonSchema = z.enum(LOGIN_FIELD_REASONS);
export type LoginFieldReason = (typeof LOGIN_FIELD_REASONS)[number];
// brain → background host. The password crosses this private port only in fillLogin params and
// the take result; the host keeps captured values in memory and never logs them.
export const LoginFillResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    username: z.boolean(),
    password: z.boolean(),
    totp: z.boolean().optional(),
    /** Optional: an older host reports none; the tools layer then says nothing. */
    reasons: z.array(LoginFieldReasonSchema).max(3).optional(),
    /**
     * The account page was its own step, and the fill pressed that page's "Next" / "Continue"
     * itself (never the final sign-in). Optional so an older host's result still validates.
     */
    continueClicked: z.boolean().optional(),
    /**
     * The step after the account page asked for a one-time code and the account has no usable
     * TOTP. The account is already filled, so this is a success with a hand-over, not
     * `totp_unavailable` (which would hide that the account step worked).
     */
    needsCode: z.boolean().optional(),
    page: BrowserPageSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["origin_mismatch", "no_fields", "no_page", "page_changed", "totp_unavailable"]),
  }),
]);
export const CredentialHostMethods = {
  "host.browser.login.takeoverPage": {
    params: z.strictObject({ botId: IdSchema, groupId: IdSchema.optional() }),
    result: z.strictObject({ page: BrowserPageSchema, documentId: IdSchema }).nullable(),
  },
  "host.browser.fillLogin": {
    params: z.strictObject({
      botId: IdSchema,
      groupId: IdSchema.optional(),
      runId: IdSchema.optional(),
      tab: HostBrowserTabIdSchema.optional(),
      site: CredentialSiteSchema,
      username: z.string().max(500),
      password: secretText,
      totp: z
        .string()
        .regex(/^(?:[0-9]{6}|[0-9]{8})$/)
        .optional(),
      totpExpiresAt: z.number().int().positive().safe().optional(),
      takeover: z.strictObject({ tab: HostBrowserTabIdSchema, documentId: IdSchema }).optional(),
    }),
    result: LoginFillResultSchema,
  },
  "host.browser.login.capture": {
    params: z.strictObject({ botId: IdSchema }),
    result: z
      .strictObject({
        captureId: IdSchema,
        site: CredentialSiteSchema,
        username: username.nullable(),
      })
      .nullable(),
  },
  "host.browser.login.take": {
    params: z.strictObject({ botId: IdSchema, captureId: IdSchema }),
    result: z.strictObject({
      site: CredentialSiteSchema,
      username: z.string().max(500),
      password: secretText,
    }),
  },
  "host.browser.login.discard": {
    params: z.strictObject({ botId: IdSchema, captureId: IdSchema.optional() }),
    result: z.null(),
  },
  "host.credentials.authenticate": {
    params: z.strictObject({ reason: z.string().min(1).max(200).refine(plainText) }),
    result: z.strictObject({
      ok: z.boolean(),
      code: z.enum(["cancelled", "unsupported", "failed"]).optional(),
    }),
  },
} as const;

export type Credential = z.infer<typeof CredentialSchema>;
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;
export type CredentialSave = z.infer<typeof CredentialSaveSchema>;
export type CredentialCapture = z.infer<typeof CredentialCaptureSchema>;
export type LoginFillResult = z.infer<typeof LoginFillResultSchema>;
