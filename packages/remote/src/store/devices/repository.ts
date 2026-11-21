import type { DatabaseSync } from "node:sqlite";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { DeviceNameSchema, type DeviceView, DeviceViewSchema } from "@pibot/remote-contract";
import { z } from "zod";

export interface DeviceRecord
  extends Omit<DeviceView, "online" | "path" | "directFailure" | "isolation"> {
  publicKey: string | null;
  room: string | null;
  pushToken: string | null;
}
const columns =
  "id, name, kind, public_key AS publicKey, room, push_token AS pushToken, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt";
const PrivateFields = z.strictObject({
  publicKey: z.string().min(16).max(4096).nullable(),
  room: z.string().min(1).max(512).nullable(),
  pushToken: z.string().max(128).nullable(),
});
function record(row: Record<string, unknown>): DeviceRecord {
  const view = DeviceViewSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    online: false,
  });
  const {
    path: _path,
    online: _online,
    directFailure: _failure,
    isolation: _isolation,
    ...persistent
  } = view;
  return {
    ...persistent,
    ...PrivateFields.parse({ publicKey: row.publicKey, room: row.room, pushToken: row.pushToken }),
  };
}
export class RemoteDevicesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): DeviceRecord | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM remote_devices WHERE id = ?`).get(id);
    return row ? record(row) : undefined;
  }
  require(id: string) {
    const row = this.get(id);
    if (!row) throw new RpcError(RpcErrorCodes.invalidParams, "remote_device_unavailable");
    return row;
  }
  hasRooms() {
    return !!this.db.prepare("SELECT id FROM remote_devices WHERE room IS NOT NULL LIMIT 1").get();
  }
  active(id: string) {
    const row = this.require(id);
    if (row.revokedAt || !row.publicKey || !row.room)
      throw new RpcError(RpcErrorCodes.closed, "remote_device_revoked");
    return row;
  }
  page(
    input: {
      after?: string;
      limit?: number;
      includeRevoked?: boolean;
      includeRevocationPending?: boolean;
    } = {},
  ) {
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM remote_devices WHERE id > ? AND (? = 1 OR revoked_at IS NULL OR (? = 1 AND room IS NOT NULL)) ORDER BY id LIMIT ?`,
      )
      .all(
        input.after ?? "",
        input.includeRevoked ? 1 : 0,
        input.includeRevocationPending ? 1 : 0,
        limit + 1,
      );
    return {
      items: rows.slice(0, limit).map(record),
      nextAfter: rows.length > limit ? String(rows[limit - 1]?.id) : null,
    };
  }
  add(input: {
    id: string;
    name: string;
    publicKey: string;
    room: string;
    kind?: "phone" | "runner";
  }) {
    const count = Number(
      this.db.prepare("SELECT count(*) AS n FROM remote_devices WHERE revoked_at IS NULL").get()?.n,
    );
    if (count >= 32) throw new RpcError(RpcErrorCodes.busy, "remote_device_capacity");
    if (
      this.db
        .prepare("SELECT id FROM remote_devices WHERE public_key = ? AND revoked_at IS NULL")
        .get(input.publicKey)
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_device_already_paired");
    this.db
      .prepare(
        "INSERT INTO remote_devices(id,name,kind,public_key,room,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        input.id,
        DeviceNameSchema.parse(input.name),
        input.kind ?? "phone",
        input.publicKey,
        input.room,
        new Date().toISOString(),
      );
    return this.active(input.id);
  }
  rename(id: string, name: string) {
    this.active(id);
    this.db
      .prepare("UPDATE remote_devices SET name = ? WHERE id = ? AND revoked_at IS NULL")
      .run(DeviceNameSchema.parse(name), id);
    return this.active(id);
  }
  seen(id: string) {
    this.db
      .prepare("UPDATE remote_devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
  }
  pushReference(id: string, reference: string | null) {
    this.active(id);
    this.db
      .prepare("UPDATE remote_devices SET push_token = ? WHERE id = ? AND revoked_at IS NULL")
      .run(reference, id);
  }
  revoke(id: string) {
    this.require(id);
    this.db
      .prepare(
        // A revoked runner keeps its public key until the deletion reaches it: that key is what lets
        // this desktop meet the peer again and confirm the revocation. It grants no access by itself.
        "UPDATE remote_devices SET public_key = CASE WHEN kind = 'runner' THEN public_key ELSE NULL END, push_token = NULL, revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
      )
      .run(new Date().toISOString(), id);
  }
  clearRoom(id: string) {
    this.db
      // Dropping the room ends the retry window, so the public key kept for it goes too.
      .prepare(
        "UPDATE remote_devices SET room = NULL, public_key = NULL WHERE id = ? AND revoked_at IS NOT NULL",
      )
      .run(id);
  }
}
