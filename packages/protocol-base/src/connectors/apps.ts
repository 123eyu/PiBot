import { z } from "zod";

export const BuiltinAppIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/);
export const BuiltinAppModeSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const localized = z.strictObject({ zh: z.string().max(4096), en: z.string().max(4096) });
export const BuiltinAppSchema = z.strictObject({
  id: BuiltinAppIdSchema,
  name: localized,
  description: localized,
  category: z.enum(["development", "documents", "local"]),
  supported: z.boolean(),
  unsupportedReason: z.string().max(128).nullable(),
  modes: z
    .array(
      z.strictObject({
        id: BuiltinAppModeSchema,
        auth: z.enum(["none", "bearer", "oauth", "system"]),
        capability: localized,
        help: localized,
        documentationUrl: z.url({ protocol: /^https$/ }),
      }),
    )
    .max(4),
});
export const BuiltinAppConnectSchema = z.strictObject({
  appId: BuiltinAppIdSchema,
  mode: BuiltinAppModeSchema,
  /** Account address for built-in connectors whose login needs an explicit mailbox. */
  email: z.string().email().max(320).optional(),
  // A write-only credential, never returned with a connection or manifest.
  token: z
    .string()
    .min(1)
    .max(16384)
    .refine((value) => !/[\0\r\n]/.test(value))
    .optional(),
  enable: z.boolean(),
});
export type BuiltinApp = z.output<typeof BuiltinAppSchema>;
export type BuiltinAppConnect = z.output<typeof BuiltinAppConnectSchema>;
