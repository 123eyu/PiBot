import type { DatabaseSync } from "node:sqlite";
import {
  type CloudConfig,
  CloudConfigSchema,
  CustomProviderSchema,
  type ProviderAuthState,
  ProviderAuthStateSchema,
  StoredProviderSchema,
} from "@pibot/models-contract/full";

import { transaction } from "@pibot/storage";

type JsonValue = import("zod").z.infer<typeof StoredProviderSchema>["config"][string];
export interface StoredProvider {
  id: string;
  kind: "builtin" | "custom";
  config: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
}

function validateConfig(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) validateConfig(item);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (
        /(?:apikey|secret|password|credential|privatekey)/.test(normalized) ||
        (normalized !== "maxtokens" && /tokens?$/.test(normalized)) ||
        [
          "authorization",
          "proxyauthorization",
          "cookie",
          "setcookie",
          "auth",
          "key",
          "accesskey",
          "accesskeyid",
          "sessionkey",
          "signingkey",
          "encryptionkey",
          "passwd",
          "pwd",
        ].includes(normalized)
      ) {
        throw new TypeError("Provider config must not contain secrets");
      }
      if (normalized === "headers" && item !== null && typeof item === "object") {
        for (const header of Object.values(item)) {
          if (typeof header !== "string" || header.startsWith("!") || /[\r\n]/.test(header)) {
            throw new TypeError("Unsafe provider header");
          }
        }
      }
      validateConfig(item);
    }
  }
}

const providerColumns = "id, kind, config, created_at AS createdAt, updated_at AS updatedAt";
function parseProvider(row: Record<string, unknown>): StoredProvider {
  const provider = StoredProviderSchema.parse({ ...row, config: JSON.parse(String(row.config)) });
  validateConfig(provider.config);
  if (provider.kind === "custom")
    CustomProviderSchema.omit({ apiKey: true }).parse(provider.config);
  return provider;
}

export class ProvidersRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): StoredProvider | undefined {
    const row = this.db.prepare(`SELECT ${providerColumns} FROM providers WHERE id = ?`).get(id);
    return row ? parseProvider(row) : undefined;
  }

  list(): StoredProvider[] {
    return this.db
      .prepare(`SELECT ${providerColumns} FROM providers ORDER BY rowid`)
      .all()
      .map(parseProvider);
  }

  upsert(input: Pick<StoredProvider, "id" | "kind" | "config">): StoredProvider {
    if (!input.id || !["builtin", "custom"].includes(input.kind))
      throw new TypeError("Invalid provider");
    // Validate the serialized snapshot too, so toJSON cannot smuggle a credential into storage.
    validateConfig(input.config);
    const config = JSON.parse(JSON.stringify(input.config)) as unknown;
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new TypeError("Invalid provider config");
    validateConfig(config);
    if (input.kind === "custom") CustomProviderSchema.omit({ apiKey: true }).parse(config);
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO providers (id, kind, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, config = excluded.config, updated_at = excluded.updated_at`)
      .run(input.id, input.kind, JSON.stringify(config), now, now);
    return this.get(input.id) as StoredProvider;
  }

  getCloudConfig(id: string): CloudConfig | null {
    const value = this.get(id)?.config.cloud;
    return value ? CloudConfigSchema.parse(value) : null;
  }
  setCloudConfig(input: CloudConfig): StoredProvider {
    const v = CloudConfigSchema.parse(input);
    return transaction(this.db, () => {
      const current = this.get(v.providerId);
      return this.upsert({
        id: v.providerId,
        kind: "builtin",
        config: { ...current?.config, cloud: v },
      });
    });
  }
  authState(id: string): ProviderAuthState {
    const p = this.get(id);
    return ProviderAuthStateSchema.parse({
      providerId: id,
      state: p?.config.authState ?? "disconnected",
      error: p?.config.authError ?? undefined,
    });
  }
  setAuthState(input: ProviderAuthState): ProviderAuthState {
    const v = ProviderAuthStateSchema.parse(input);
    return transaction(this.db, () => {
      const p = this.get(v.providerId);
      this.upsert({
        id: v.providerId,
        kind: p?.kind ?? "builtin",
        config: { ...p?.config, authState: v.state, authError: v.error ?? null },
      });
      return this.authState(v.providerId);
    });
  }
  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM providers WHERE id = ?").run(id).changes > 0;
  }
}
