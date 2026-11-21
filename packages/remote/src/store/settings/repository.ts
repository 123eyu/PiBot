import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  defaultRemoteDirect,
  type RemoteSettings,
  RemoteSettingsSchema,
} from "@pibot/remote-contract";
export class RemoteSettingsRepo {
  constructor(private readonly db: DatabaseSync) {
    this.db
      .prepare("INSERT OR IGNORE INTO remote_settings(singleton,desktop_id,settings) VALUES(1,?,?)")
      .run(
        randomUUID(),
        JSON.stringify({
          enabled: false,
          relay: "official",
          relayUrl: null,
          desktopName: "Pi Bot",
          keepAwake: false,
          direct: defaultRemoteDirect(),
          lanDiscovery: true,
          version: 0,
        }),
      );
  }
  get(): RemoteSettings {
    const row = this.db.prepare("SELECT settings FROM remote_settings WHERE singleton = 1").get();
    return RemoteSettingsSchema.parse(JSON.parse(String(row?.settings)));
  }
  desktopId(): string {
    return String(
      this.db.prepare("SELECT desktop_id FROM remote_settings WHERE singleton = 1").get()
        ?.desktop_id,
    );
  }
  set(expectedVersion: number, patch: Partial<Omit<RemoteSettings, "version">>) {
    const current = this.get();
    if (current.version !== expectedVersion)
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_settings_stale");
    const value = RemoteSettingsSchema.parse({
      ...current,
      ...patch,
      version: current.version + 1,
    });
    this.db
      .prepare("UPDATE remote_settings SET settings = ? WHERE singleton = 1")
      .run(JSON.stringify(value));
    return value;
  }
}
