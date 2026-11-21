import { unbase64, utf8 } from "@pibot/link";
import { isLanAddress } from "@pibot/link/lan";
import { z } from "zod";

const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const CredentialBaseSchema = z.strictObject({
  version: z.literal(1),
  seed: key,
  roomKey: key,
  publicKey: key,
  relay: z.string().max(1024),
});
const RawCredentialSchema = CredentialBaseSchema.extend({ lanAddresses: z.unknown().optional() });
export const CredentialSchema = CredentialBaseSchema.extend({
  lanAddresses: z.array(z.string()).max(8),
});
export type Credential = z.infer<typeof CredentialSchema>;

const validLanAddress = (address: string) => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  return (
    url.protocol === "ws:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    isLanAddress(url.hostname) &&
    !!url.port &&
    /^\/link\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
  );
};

/** Optional routing hints are disposable metadata; they must never poison identity fields. */
export function sanitizeLanAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (result.length >= 8 || typeof item !== "string" || item.length > 256) continue;
    if (validLanAddress(item) && !result.includes(item)) result.push(item);
  }
  return result;
}

export function readCredential(raw: string) {
  // Parse a bounded envelope first. Oversized optional hints are discarded by the sanitizer;
  // an unbounded blob is still rejected before JSON parsing can consume the app.
  if (raw.length > 16_384) throw new Error("credential_invalid");
  const parsed = RawCredentialSchema.parse(JSON.parse(raw));
  const value = { ...parsed, lanAddresses: sanitizeLanAddresses(parsed.lanAddresses) };
  // A stored endpoint is bound to the scanned relay, not a caller-selected URL.
  const relay = new URL(value.relay);
  if (relay.protocol !== "wss:" || relay.username || relay.password || relay.search || relay.hash)
    throw new Error("credential_invalid");
  for (const item of [value.seed, value.roomKey, value.publicKey]) {
    const bytes = unbase64(item, 32);
    if (bytes.length !== 32) throw new Error("credential_invalid");
    bytes.fill(0);
  }
  return value;
}

export function withLanAddresses(raw: string, addresses: unknown) {
  const value = readCredential(raw);
  // Identity is never shortened to fit an optional optimization. Keep the original credential
  // and skip its route-hint write if even the core alone exceeds SecureStore's byte budget.
  if (utf8(JSON.stringify({ ...value, lanAddresses: [] })).length > 2048) return undefined;
  const hints = sanitizeLanAddresses(addresses);
  while (hints.length && utf8(JSON.stringify({ ...value, lanAddresses: hints })).length > 2048)
    hints.pop();
  return JSON.stringify({ ...value, lanAddresses: hints });
}
