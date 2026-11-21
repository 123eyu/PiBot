import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { IdSchema } from "../core/ids.ts";

// Saved website accounts. A site is an http(s) origin (scheme, host, port; no path). This
// file has no dependency on local-exec so approvals and grants can reference it without a cycle.

function parseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** `https://example.com` style origin; lowercase host, default ports dropped (URL.origin). */
export const CredentialSiteSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => parseOrigin(value)?.origin === value, "Website origin required");

/**
 * What the user typed ("example.com", "https://example.com/login") as an origin. Bare names mean
 * https; anything that is not a public-looking http(s) address returns undefined.
 */
export function credentialSite(input: string): string | undefined {
  const value = input.trim();
  if (!value || /[\s\p{Cc}]/u.test(value)) return undefined;
  const url = parseOrigin(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!url) return undefined;
  const origin = url.origin;
  return CredentialSiteSchema.safeParse(origin).success ? origin : undefined;
}

// URL already normalizes IPv4 spellings to dotted decimal and keeps IPv6 in brackets.
const isAddress = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
const hostOf = (url: URL) =>
  url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

/**
 * Whether a saved site may be used on `pageUrl`: same scheme and port, and the
 * page host equals the site host or is a subdomain of it at a dot boundary (`example.com` covers
 * `www.example.com`, not `evil-example.com` or `example.com.evil.net`); IP addresses match only
 * exactly. Brain checks this before asking; the host checks it again against the live page.
 */
export function credentialSiteMatches(site: string, pageUrl: string): boolean {
  const saved = parseOrigin(site);
  const page = parseOrigin(pageUrl);
  if (!saved || !page) return false;
  if (saved.protocol !== page.protocol || saved.port !== page.port) return false;
  const want = hostOf(saved);
  const have = hostOf(page);
  if (!want || !have) return false;
  if (isAddress(want) || isAddress(have)) return want === have;
  return have === want || have.endsWith(`.${want}`);
}

/** Display text for a site: its host (with a non-default port), never a path. */
export function credentialSiteLabel(site: string): string {
  const url = parseOrigin(site);
  return url ? url.host : site;
}

const label = z.string().trim().min(1).max(200).refine(plainText);

/** One saved account offered on the first-login card: id and display name, never the secret. */
export const CredentialChoiceSchema = z.strictObject({ id: IdSchema, label });
/** The "<Bot> wants to log in to <site> as <account>" card; resolved by its own RPC. */
export const LoginApprovalRequestSchema = z.strictObject({
  site: CredentialSiteSchema,
  accounts: z.array(CredentialChoiceSchema).min(1).max(20),
});

export type CredentialChoice = z.infer<typeof CredentialChoiceSchema>;
export type LoginApprovalRequest = z.infer<typeof LoginApprovalRequestSchema>;
