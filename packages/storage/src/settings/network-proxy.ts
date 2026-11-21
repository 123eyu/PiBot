import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type NetworkProxyConfig, NetworkProxyConfigSchema } from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

export class NetworkProxyRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(): NetworkProxyConfig {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='network_proxy'").get();
    return row
      ? NetworkProxyConfigSchema.parse(JSON.parse(String(row.value)))
      : { enabled: false, address: null, hasCredentials: false };
  }
  save(
    config: NetworkProxyConfig,
    credential: Uint8Array | null | undefined,
    audit: () => void,
  ): void {
    transaction(this.db, () => {
      if (credential === null)
        this.db.prepare("DELETE FROM secrets WHERE scope='network_proxy' AND name='url'").run();
      else if (credential !== undefined)
        this.db
          .prepare(`INSERT INTO secrets (id,scope,name,ciphertext,hint,created_at,last_used_at)
          VALUES (?,'network_proxy','url',?,NULL,?,NULL) ON CONFLICT(scope,name) DO UPDATE SET
          ciphertext=excluded.ciphertext,hint=NULL,last_used_at=NULL`)
          .run(randomUUID(), credential, new Date().toISOString());
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES ('network_proxy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(NetworkProxyConfigSchema.parse(config)));
      audit();
    });
  }
}
