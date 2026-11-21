import { z } from "zod";

// Credentials are write-only; public URLs always omit userinfo.
export const ProxyAddressSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return (
        !/[\s\p{Cc}]/u.test(value) &&
        url.href.length <= 2048 &&
        ["http:", "https:"].includes(url.protocol) &&
        !!url.hostname &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "HTTP(S) proxy address required");
export const PublicProxyAddressSchema = ProxyAddressSchema.refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password;
});
export const NetworkProxyConfigSchema = z
  .strictObject({
    enabled: z.boolean(),
    address: PublicProxyAddressSchema.nullable(),
    hasCredentials: z.boolean(),
  })
  .refine((value) => value.address !== null || (!value.enabled && !value.hasCredentials));
export const NetworkProxySetSchema = z.strictObject({
  enabled: z.boolean(),
  address: ProxyAddressSchema.nullable().optional(),
  clearCredentials: z.boolean().optional(),
});
export const NetworkProxyTestSchema = z.strictObject({
  ok: z.boolean(),
  reason: z.enum([
    "connected",
    "disabled",
    "proxy_unavailable",
    "proxy_auth_failed",
    "credentials_unavailable",
    "destination_unavailable",
    "timeout",
  ]),
  address: PublicProxyAddressSchema.nullable(),
});
export type NetworkProxyConfig = z.infer<typeof NetworkProxyConfigSchema>;
