import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

const tab = z
  .string()
  .regex(/^t[1-9][0-9]{0,5}$/)
  .optional();
export const BrowserSecretHandleSchema = z.string().regex(/^«secret:h[a-f0-9]{32}»$/);
// A named boundary keeps the aggregate RPC declaration from expanding this shape at every use.
export interface BrowserSecretUse {
  handle: string;
  tab: string;
  documentId: string;
  kind: "network" | "cookie" | "localStorage" | "sessionStorage";
  site: string;
  name: string;
  length: number;
  destination: string;
}
export const BrowserSecretUseSchema: z.ZodType<BrowserSecretUse, BrowserSecretUse> = z.strictObject(
  {
    handle: BrowserSecretHandleSchema,
    tab: z.string().regex(/^t[1-9][0-9]{0,5}$/),
    documentId: IdSchema,
    kind: z.enum(["network", "cookie", "localStorage", "sessionStorage"]),
    site: z.string().max(2048),
    name: z.string().max(256),
    length: z.number().int().nonnegative(),
    destination: z.string().min(1).max(4096),
  },
);
export const BrowserNetworkQuerySchema = z.strictObject({
  tab,
  after: z.number().int().nonnegative().safe().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export const BrowserRequestSchema = z.strictObject({
  tab,
  origin: z.url().max(2048),
  url: z.string().min(1).max(8192),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  headers: z
    .record(z.string().regex(/^[a-zA-Z0-9-]{1,64}$/), z.string().max(1024))
    .refine(
      (headers) =>
        Object.keys(headers).length <= 32 &&
        Object.entries(headers).every(
          ([name, value]) =>
            !/^(cookie|host|origin|referer|connection|content-length|proxy-|sec-)/i.test(name) &&
            !/[\r\n\0]/.test(value) &&
            (/^(accept|content-type|accept-language)$/i.test(name) ||
              /«secret:h[a-f0-9]{32}»/.test(value)),
        ),
    )
    .optional(),
  body: z.string().max(16384).optional(),
});
export const BrowserSecretSchema = z.strictObject({
  tab,
  documentId: IdSchema,
  handle: BrowserSecretHandleSchema.optional(),
  origin: z.url().max(2048),
  kind: z.enum(["handle", "cookie", "localStorage", "sessionStorage"]),
  name: z.string().min(1).max(256),
});
export const BrowserNetworkEntrySchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  method: z.string().max(32),
  url: z.string().max(8192),
  status: z.number().int(),
  resourceType: z.string().max(64),
  durationMs: z.number().nonnegative(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()),
  body: z.string().max(4096).optional(),
});
export const BrowserNetworkSchema = z.strictObject({
  documentId: IdSchema,
  oldestSeq: z.number().int().nonnegative(),
  nextSeq: z.number().int().nonnegative(),
  dropped: z.boolean(),
  entries: z.array(BrowserNetworkEntrySchema).max(50),
  storage: z
    .array(
      z.strictObject({
        kind: z.enum(["cookie", "localStorage", "sessionStorage"]),
        name: z.string().max(256),
        length: z.number().int().nonnegative(),
        secure: z.boolean().optional(),
        httpOnly: z.boolean().optional(),
        sameSite: z.string().optional(),
      }),
    )
    .max(150),
});
const scope = { botId: IdSchema, groupId: IdSchema.optional(), runId: IdSchema.optional() };
export const BrowserNetworkHostMethods = {
  "host.browser.network": {
    params: BrowserNetworkQuerySchema.extend(scope),
    result: BrowserNetworkSchema,
  },
  "host.browser.request": {
    params: BrowserRequestSchema.extend(scope),
    result: BrowserNetworkEntrySchema,
  },
  "host.browser.secret": {
    params: BrowserSecretSchema.extend(scope),
    result: z.strictObject({
      handle: BrowserSecretHandleSchema,
      kind: z.enum(["network", "cookie", "localStorage", "sessionStorage"]),
      site: z.string().max(2048),
      name: z.string().max(256),
      length: z.number().int().nonnegative(),
    }),
  },
  "host.browser.secretUses": {
    params: z.strictObject({
      ...scope,
      tab,
      origin: z.url().max(2048).optional(),
      uses: z
        .array(
          z.strictObject({
            handle: BrowserSecretHandleSchema,
            destination: z.string().min(1).max(4096),
          }),
        )
        .min(1)
        .max(32),
    }),
    result: z.strictObject({ uses: z.array(BrowserSecretUseSchema).max(32) }),
  },
  "host.browser.consumeSecrets": {
    params: z.strictObject({ ...scope, uses: z.array(BrowserSecretUseSchema).min(1).max(32) }),
    // Trusted brain execution port only; never registered as a model tool or renderer method.
    result: z.strictObject({
      values: z
        .array(z.strictObject({ handle: BrowserSecretHandleSchema, value: z.string().max(65536) }))
        .max(32),
    }),
  },
} as const;

export type BrowserNetworkQuery = z.infer<typeof BrowserNetworkQuerySchema>;
export type BrowserRequest = z.infer<typeof BrowserRequestSchema>;
export type BrowserSecret = z.infer<typeof BrowserSecretSchema>;

// Shared with the i18n aggregation; brain does not depend on the UI translation package.
export const BrowserNetworkConsentText = {
  zh: {
    use: "逐次使用秘密（不提供原值）：{sources}",
    reveal: "获取秘密句柄 {site} · {kind} · {name}（不提供原值）",
    request: "逐次确认页面请求 {site} · {kind}",
  },
  en: {
    use: "Use secret once (no raw value): {sources}",
    reveal: "Capture secret handle: {site} · {kind} · {name} (no raw value)",
    request: "Confirm page request once: {site} · {kind}",
  },
} as const;
