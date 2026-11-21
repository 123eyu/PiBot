import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface OfflineGrantRecord {
  grantId: string;
  deviceId: string;
  providerId: string;
  modelId: string;
  deliveredAt: string | null;
  createdAt: string;
}
export interface OfflineTopicRecord {
  conversationId: string;
  botId: string;
  providerId: string;
  modelId: string;
  seeded: boolean;
}
const grant = (row: Record<string, unknown>): OfflineGrantRecord => ({
  grantId: String(row.grant_id),
  deviceId: String(row.device_id),
  providerId: String(row.provider_id),
  modelId: String(row.model_id),
  deliveredAt: row.delivered_at === null ? null : String(row.delivered_at),
  createdAt: String(row.created_at),
});

/** Per-phone offline grants and the idempotency records of offline imports. */
export class RemoteOfflineRepo {
  constructor(private readonly db: DatabaseSync) {}
  /** At most OFFLINE_MAX_MODELS rows per device (the set call replaces them all). */
  grants(deviceId: string): OfflineGrantRecord[] {
    return this.db
      .prepare(
        "SELECT grant_id,device_id,provider_id,'' AS model_id,delivered_at,created_at FROM remote_offline_providers WHERE device_id=? ORDER BY created_at, rowid",
      )
      .all(deviceId)
      .map((row) => grant(row));
  }
  /**
   * Keeps the grants (and their IDs and delivery) of models still selected, so re-saving the same
   * choice never asks for a second delivery. Returns the removed ones for the clear audit.
   */
  setGrants(deviceId: string, models: readonly { providerId: string; modelId: string }[]) {
    const existing = this.grants(deviceId);
    const wanted = new Set(models.map((m) => m.providerId));
    const removed = existing.filter((g) => !wanted.has(g.providerId));
    const del = this.db.prepare("DELETE FROM remote_offline_providers WHERE grant_id=?");
    for (const row of removed) del.run(row.grantId);
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO remote_offline_providers(grant_id,device_id,provider_id,delivered_at,created_at) VALUES(?,?,?,NULL,?)",
    );
    for (const providerId of wanted) insert.run(randomUUID(), deviceId, providerId, now);
    return removed;
  }
  deliverAll(deviceId: string) {
    return this.db
      .prepare(
        "UPDATE remote_offline_providers SET delivered_at=? WHERE device_id=? AND delivered_at IS NULL",
      )
      .run(new Date().toISOString(), deviceId).changes;
  }
  /** Bots the user switched off for this phone; every other active Bot may answer offline. */
  offBots(deviceId: string): Set<string> {
    return new Set(
      this.db
        .prepare("SELECT bot_id FROM remote_offline_bots_off WHERE device_id=? LIMIT 200")
        .all(deviceId)
        .map((row) => String(row.bot_id)),
    );
  }
  setBot(deviceId: string, botId: string, offline: boolean) {
    if (offline)
      this.db
        .prepare("DELETE FROM remote_offline_bots_off WHERE device_id=? AND bot_id=?")
        .run(deviceId, botId);
    else
      this.db
        .prepare(
          "INSERT OR IGNORE INTO remote_offline_bots_off(device_id,bot_id,created_at) VALUES(?,?,?)",
        )
        .run(deviceId, botId, new Date().toISOString());
  }
  /** Revoke / unpair: the phone loses every grant; imported chats stay on the computer. */
  clearDevice(deviceId: string) {
    const removed = this.grants(deviceId);
    this.db.prepare("DELETE FROM remote_offline_providers WHERE device_id=?").run(deviceId);
    this.db.prepare("DELETE FROM remote_offline_bots_off WHERE device_id=?").run(deviceId);
    return removed;
  }
  topic(deviceId: string, localTopicId: string): OfflineTopicRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT conversation_id,bot_id,provider_id,model_id,seeded FROM remote_offline_topics WHERE device_id=? AND local_topic_id=?",
      )
      .get(deviceId, localTopicId);
    return row
      ? {
          conversationId: String(row.conversation_id),
          botId: String(row.bot_id),
          providerId: String(row.provider_id),
          modelId: String(row.model_id),
          seeded: row.seeded === 1,
        }
      : undefined;
  }
  addTopic(deviceId: string, localTopicId: string, value: Omit<OfflineTopicRecord, "seeded">) {
    this.db
      .prepare(
        "INSERT INTO remote_offline_topics(device_id,local_topic_id,conversation_id,bot_id,provider_id,model_id,seeded,created_at) VALUES(?,?,?,?,?,?,0,?)",
      )
      .run(
        deviceId,
        localTopicId,
        value.conversationId,
        value.botId,
        value.providerId,
        value.modelId,
        new Date().toISOString(),
      );
  }
  markSeeded(deviceId: string, localTopicId: string) {
    this.db
      .prepare("UPDATE remote_offline_topics SET seeded=1 WHERE device_id=? AND local_topic_id=?")
      .run(deviceId, localTopicId);
  }
  /** The record of one uploaded item, or undefined when it is new. */
  item(deviceId: string, clientId: string): { kind: string; targetId: string | null } | undefined {
    const row = this.db
      .prepare("SELECT kind,target_id FROM remote_offline_items WHERE device_id=? AND client_id=?")
      .get(deviceId, clientId);
    return row
      ? { kind: String(row.kind), targetId: row.target_id === null ? null : String(row.target_id) }
      : undefined;
  }
  addItem(
    deviceId: string,
    localTopicId: string,
    clientId: string,
    kind: "message" | "audit" | "memory" | "egress",
    targetId: string | null,
  ) {
    this.db
      .prepare(
        "INSERT INTO remote_offline_items(device_id,client_id,local_topic_id,kind,target_id,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(deviceId, clientId, localTopicId, kind, targetId, new Date().toISOString());
  }
  /** Imported message IDs of one local topic, in upload order (a topic holds a few hundred). */
  messageIds(deviceId: string, localTopicId: string): string[] {
    return this.db
      .prepare(
        "SELECT target_id FROM remote_offline_items WHERE device_id=? AND local_topic_id=? AND kind='message' ORDER BY rowid LIMIT 1000",
      )
      .all(deviceId, localTopicId)
      .map((row) => String(row.target_id));
  }
}
