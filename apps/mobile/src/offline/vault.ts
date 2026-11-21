/**
 * Model keys the computer delivered, only in the platform secure store (Android
 * Keystore / iOS Keychain), never in SQLite, logs, snapshots of React state or the screen. The
 * phone keeps only digests elsewhere (`store.ts`) to tell the computer which keys it holds.
 */
export interface KeyVault {
  get(computerId: string, grantId: string): Promise<string | null>;
  set(computerId: string, grantId: string, key: string): Promise<void>;
  remove(computerId: string, grantId: string): Promise<void>;
}
/** Secure-store item names allow only [A-Za-z0-9._-]; both IDs are UUIDs. */
export const vaultName = (computerId: string, grantId: string) =>
  `pibot.offline.${computerId}.${grantId}`;
/** Dev probes and the Node acceptance: the same contract in memory. */
export function memoryVault(): KeyVault & { size(): number; has(c: string, g: string): boolean } {
  const values = new Map<string, string>();
  return {
    get: async (c, g) => values.get(vaultName(c, g)) ?? null,
    set: async (c, g, key) => void values.set(vaultName(c, g), key),
    remove: async (c, g) => void values.delete(vaultName(c, g)),
    size: () => values.size,
    has: (c, g) => values.has(vaultName(c, g)),
  };
}

/**
 * What one vault item holds: the key alone (older deliveries) or, when the provider needs custom
 * request headers (maintainers 2026-11-12), the key and those headers together.
 */
export interface OfflineCredential {
  key: string;
  headers?: Record<string, string>;
}
export function encodeCredential(value: OfflineCredential) {
  return value.headers ? JSON.stringify({ key: value.key, headers: value.headers }) : value.key;
}
export function decodeCredential(stored: string): OfflineCredential {
  if (!stored.startsWith('{"key"')) return { key: stored };
  try {
    const parsed = JSON.parse(stored) as { key?: unknown; headers?: unknown };
    if (typeof parsed.key !== "string") return { key: stored };
    const headers =
      parsed.headers && typeof parsed.headers === "object"
        ? Object.fromEntries(
            Object.entries(parsed.headers as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
    return { key: parsed.key, ...(headers ? { headers } : {}) };
  } catch {
    // A key that merely looks like JSON is still a key.
    return { key: stored };
  }
}
