import { isIP } from "node:net";
import { DomainSchema } from "@pibot/protocol-base";
import { parse } from "tldts";
import { PolicyTargetError } from "../core/errors.ts";
import type { PolicyTrace } from "../core/explain.ts";

/** DNS and every redirect must be checked again by exec against the actual connection address. */
export function website(
  url: string,
  trace?: PolicyTrace,
): {
  url: string;
  domain?: string;
  host: string;
  denied: boolean;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PolicyTargetError("url_resolution_failed");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new PolicyTargetError("url_resolution_failed");
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const ipv4 = host.split(".").map(Number);
  const localV4 =
    isIP(host) === 4 &&
    (ipv4[0] === 127 ||
      ipv4[0] === 10 ||
      ipv4[0] === 0 ||
      (ipv4[0] === 172 && (ipv4[1] ?? 0) >= 16 && (ipv4[1] ?? 0) <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168) ||
      (ipv4[0] === 169 && ipv4[1] === 254));
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  const mappedV4 = mapped
    ? `${parseInt(mapped[1] as string, 16) >> 8}.${parseInt(mapped[1] as string, 16) & 255}.${parseInt(mapped[2] as string, 16) >> 8}.${parseInt(mapped[2] as string, 16) & 255}`
    : undefined;
  const localV6 =
    isIP(host) === 6 &&
    (/^(::|::1)$|^(fc|fd|fe[89ab])/i.test(host) ||
      !!(mappedV4 && website(`http://${mappedV4}`).denied));
  const denied =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local") ||
    localV4 ||
    localV6;
  // T2's domain schema cannot persist IPv6 scopes; allow public literals without remember.
  const domain = !denied && isIP(host) !== 6 ? DomainSchema.safeParse(host) : undefined;
  if (domain && !domain.success) throw new PolicyTargetError("url_resolution_failed");
  trace?.step("boundary", denied ? "local_network_address" : "public_network_address", "info");
  return {
    url: parsed.href,
    host,
    ...(domain?.success ? { domain: domain.data } : {}),
    denied,
  };
}

/** Private suffixes separate tenants (e.g. github.io); literals and unknown suffixes get no scope. */
export function publicReadDomain(url: string): string | undefined {
  const target = website(url);
  if (target.denied || isIP(target.host)) return;
  const parsed = parse(target.host, { allowPrivateDomains: true, validateHostname: true });
  return parsed.isIcann || parsed.isPrivate ? (parsed.domain ?? undefined) : undefined;
}
