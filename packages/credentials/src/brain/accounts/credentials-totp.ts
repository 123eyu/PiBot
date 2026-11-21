import { createHmac } from "node:crypto";
import {
  CredentialTotpSecretSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/credentials-contract/full";
import type { z } from "zod";

const invalid = () => new RpcError(RpcErrorCodes.invalidParams, "credential_totp_invalid");
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Only this encrypted shape is persisted; no label, URI or secret is returned to clients. */
export const TotpConfigSchema = CredentialTotpSecretSchema;
export type TotpConfig = z.infer<typeof TotpConfigSchema>;

function decodeBase32(input: string): Buffer {
  const raw = input.toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(raw)) throw invalid();
  const value = raw.replace(/=+$/, "");
  if (![0, 2, 4, 5, 7].includes(value.length % 8)) throw invalid();
  if (raw.includes("=") && raw.length % 8 !== 0) throw invalid();
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const char of value) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (accumulator !== 0 || bytes.length < 10 || bytes.length > 640) throw invalid();
  return Buffer.from(bytes);
}

/** Google Key URI format; HOTP, duplicate parameters and unsupported settings fail closed. */
export function parseTotp(input: string): TotpConfig {
  let secret = input.trim();
  let algorithm = "SHA1";
  let digits = 6;
  let period = 30;
  if (/^otpauth:/i.test(secret)) {
    let uri: URL;
    try {
      uri = new URL(secret);
    } catch {
      throw invalid();
    }
    if (
      uri.protocol !== "otpauth:" ||
      uri.hostname !== "totp" ||
      uri.port ||
      uri.username ||
      uri.password ||
      uri.hash ||
      uri.pathname.length < 2
    )
      throw invalid();
    let label: string;
    try {
      label = decodeURIComponent(uri.pathname.slice(1));
    } catch {
      throw invalid();
    }
    if (!label.trim() || /[\p{Cc}]/u.test(label)) throw invalid();
    const allowed = new Set(["secret", "issuer", "algorithm", "digits", "period"]);
    for (const key of uri.searchParams.keys())
      if (!allowed.has(key) || uri.searchParams.getAll(key).length !== 1) throw invalid();
    const issuer = uri.searchParams.get("issuer");
    const separator = label.indexOf(":");
    if (
      issuer !== null &&
      (!issuer.trim() ||
        /[\p{Cc}]/u.test(issuer) ||
        (separator >= 0 && label.slice(0, separator) !== issuer))
    )
      throw invalid();
    secret = uri.searchParams.get("secret") ?? "";
    algorithm = (uri.searchParams.get("algorithm") ?? algorithm).toUpperCase();
    const integer = (key: string, fallback: number) => {
      const value = uri.searchParams.get(key);
      if (value === null) return fallback;
      if (!/^[1-9][0-9]{0,2}$/.test(value)) throw invalid();
      return Number(value);
    };
    digits = integer("digits", digits);
    period = integer("period", period);
  }
  secret = secret.toUpperCase();
  const key = decodeBase32(secret);
  key.fill(0);
  const parsed = TotpConfigSchema.safeParse({
    secret: secret.replace(/=+$/, ""),
    algorithm,
    digits,
    period,
  });
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/** RFC 6238; called immediately before private host dispatch, never in model/renderer code. */
export function currentTotp(config: TotpConfig, now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) throw invalid();
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / config.period)));
  const key = decodeBase32(config.secret);
  try {
    const digest = createHmac(config.algorithm.toLowerCase(), key).update(counter).digest();
    const offset = (digest[digest.length - 1] as number) & 15;
    const number = digest.readUInt32BE(offset) & 0x7fffffff;
    return String(number % 10 ** config.digits).padStart(config.digits, "0");
  } finally {
    key.fill(0);
  }
}
