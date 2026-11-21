// Subpath, like availability/storage-errors.ts: the root evaluates every schema.
import { SafeSecretSchema } from "@pibot/protocol-base/values";
import { keyPattern } from "./redaction/redaction-patterns.ts";

/** Desktop hosts inject safeStorage through host RPC; this package stays pure Node. */
export interface SecretCipher {
  /** A transient failure may reject with a fixed secretsUnavailable reason; false is unavailable. */
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Uint8Array>;
  decrypt(cipher: Uint8Array): Promise<string>;
}

export { type SecretStorageReason, secretStorageReason } from "./availability/storage-errors.ts";

/** Contract only for now: a Node host must unlock before it can persist encrypted secrets. */
export interface MasterPasswordCipher extends SecretCipher {
  unlock(masterPassword: string): Promise<void>;
  lock(): Promise<void>;
}

export function assertSafeSecretValue(value: string): void {
  if (!SafeSecretSchema.safeParse(value).success) {
    // Schema diagnostics must never echo a rejected credential to logs or RPC callers.
    throw new TypeError("Unsafe secret value");
  }
}

export interface Redactor {
  add(secret: string): void;
  redact(text: string): string;
}

const replacement = "[REDACTED]";

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  return {
    add(secret) {
      assertSafeSecretValue(secret);
      // 太短，不可能是有效凭据；登记脱敏只会破坏正常文本和 RPC 协议字段。
      if (secret.length < 8) return;
      secrets.add(secret);
    },
    redact(text) {
      const ranges = [...text.matchAll(keyPattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      }));
      for (const secret of secrets) {
        let start = text.indexOf(secret);
        while (start !== -1) {
          ranges.push({ start, end: start + secret.length });
          // Advance one character so even overlapping occurrences are fully masked.
          start = text.indexOf(secret, start + 1);
        }
      }
      ranges.sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      // Overlapping known values and format matches must mask their entire combined extent.
      for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.start < previous.end) {
          previous.end = Math.max(previous.end, range.end);
        } else {
          merged.push({ ...range });
        }
      }
      let result = "";
      let cursor = 0;
      for (const range of merged) {
        result += text.slice(cursor, range.start) + replacement;
        cursor = range.end;
      }
      return result + text.slice(cursor);
    },
  };
}

export function keyHint(secret: string): string | undefined {
  assertSafeSecretValue(secret);
  return secret.length < 8 ? undefined : secret.slice(-4);
}

export {
  NamedRedactionBudgetError,
  type NamedRedactor,
  withNamedRedaction,
} from "./redaction/named-redactor.ts";
export {
  isSafeSecretEnvName,
  isUserSecretName,
  referencedSecretNames,
} from "./redaction/secret-names.ts";
