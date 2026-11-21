import type { DatabaseSync } from "node:sqlite";
import {
  type CheckpointCapture,
  CheckpointCaptureSchema,
  type FileCheckpoint,
  FileCheckpointSchema,
  type FileRestore,
  FileRestoreSchema,
  IdSchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import { transaction } from "../database/database.ts";
import { type ManagedIdentity, ManagedIdentitySchema } from "./managed-worktrees.ts";

export const CheckpointImageSchema = z.strictObject({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z
    .number()
    .int()
    .min(0)
    .max(100 * 1024 * 1024),
  mode: z.number().int().min(0).max(0o777),
  blob: z.string().regex(/^[0-9a-f]{64}$/),
  // Versions prepared under the same run lease, including a candidate whose publication failed.
  alternatives: z
    .array(
      z.strictObject({
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        mode: z.number().int().min(0).max(0o777),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(100 * 1024 * 1024)
          .optional(),
      }),
    )
    .max(100)
    .optional(),
});
export type CheckpointImage = z.infer<typeof CheckpointImageSchema>;
export interface CheckpointRecord extends FileCheckpoint {
  identity: ManagedIdentity;
  scopeKey: string;
  images: Map<string, { before: CheckpointImage | null; after: CheckpointImage | null }>;
}
const columns =
  "id,bot_id AS botId,run_id AS runId,scope_key AS scopeKey,root,identity_json AS identity,state,version,truncated,created_at AS createdAt";
export class FileCheckpointsRepo {
  constructor(private readonly db: DatabaseSync) {}
  /** Restore journals are historical evidence; project successful items out without deleting it. */
  restoredPaths(checkpointId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT i.path FROM file_checkpoint_items i
        WHERE i.checkpoint_id=? AND EXISTS (
          SELECT 1 FROM file_restore_items r WHERE r.item_id=i.id AND r.state='restored'
        ) LIMIT 500`,
      )
      .all(IdSchema.parse(checkpointId));
    return new Set(rows.map((row) => String(row.path)));
  }
  restoredRunPaths(runId: string): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT i.path FROM file_checkpoint_items i JOIN file_checkpoints c ON c.id=i.checkpoint_id WHERE c.run_id=? AND EXISTS (SELECT 1 FROM file_restore_items r WHERE r.item_id=i.id AND r.state='restored') LIMIT 500",
      )
      .all(IdSchema.parse(runId));
    return new Set(rows.map((row) => String(row.path)));
  }
  hasWriteToolEvidence(runId: string): boolean {
    const id = IdSchema.parse(runId);
    return !!this.db
      .prepare(
        "SELECT 1 FROM tool_calls t JOIN messages m ON m.id=t.message_id WHERE m.run_id=? AND t.tool IN ('write_file','edit_file') AND t.status IN ('done','error','aborted') LIMIT 1",
      )
      .get(id);
  }
  capture(runId: string): CheckpointCapture | undefined {
    const row = this.db
      .prepare("SELECT m.usage FROM messages m JOIN runs r ON r.message_id=m.id WHERE r.id=?")
      .get(runId);
    const value = row?.usage == null ? undefined : JSON.parse(String(row.usage))?.fileCheckpoint;
    return value === undefined ? undefined : CheckpointCaptureSchema.parse(value);
  }
  saveCapture(runId: string, value: CheckpointCapture) {
    transaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT m.id,m.usage FROM messages m JOIN runs r ON r.message_id=m.id WHERE r.id=? AND r.finished_at IS NOT NULL",
        )
        .get(runId);
      if (!row) throw new Error("Checkpoint run is not finished");
      if (this.capture(runId)) return;
      const usage = row.usage == null ? {} : JSON.parse(String(row.usage));
      this.db
        .prepare("UPDATE messages SET usage=? WHERE id=?")
        .run(
          JSON.stringify({ ...usage, fileCheckpoint: CheckpointCaptureSchema.parse(value) }),
          String(row.id),
        );
    });
  }
  projectItems(root: ManagedIdentity) {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM file_checkpoint_items i JOIN file_checkpoints c ON c.id=i.checkpoint_id WHERE c.state<>'expired' AND json_extract(c.identity_json,'$.device')=? AND json_extract(c.identity_json,'$.inode')=?",
        )
        .get(root.device, root.inode)?.n ?? 0,
    );
  }
  get(id: string): CheckpointRecord | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM file_checkpoints WHERE id=?`).get(id);
    if (!row) return undefined;
    const images: CheckpointRecord["images"] = new Map();
    const items = this.db
      .prepare(
        "SELECT id,path,kind,before_json AS beforeImage,after_json AS afterImage,reason FROM file_checkpoint_items WHERE checkpoint_id=? ORDER BY path LIMIT 500",
      )
      .all(id)
      .map((item) => {
        const before =
          item.beforeImage === null
            ? null
            : CheckpointImageSchema.parse(JSON.parse(String(item.beforeImage)));
        const after =
          item.afterImage === null
            ? null
            : CheckpointImageSchema.parse(JSON.parse(String(item.afterImage)));
        images.set(String(item.id), { before, after });
        return {
          id: item.id,
          path: item.path,
          kind: item.kind,
          restorable: item.reason === null,
          reason: item.reason,
        };
      });
    return {
      ...FileCheckpointSchema.strip().parse({ ...row, truncated: !!row.truncated, items }),
      identity: ManagedIdentitySchema.parse(JSON.parse(String(row.identity))),
      scopeKey: String(row.scopeKey),
      images,
    };
  }
  forRun(runId: string, root: string) {
    const row = this.db
      .prepare("SELECT id FROM file_checkpoints WHERE run_id=? AND root=?")
      .get(runId, root);
    return row ? this.get(String(row.id)) : undefined;
  }
  list(botId: string | null, scopeKey: string, root: string, limit: number, before?: string) {
    return this.db
      .prepare(
        "SELECT id FROM file_checkpoints WHERE (? IS NULL OR bot_id=?) AND scope_key=? AND root=? AND (? IS NULL OR rowid<(SELECT rowid FROM file_checkpoints WHERE id=?)) ORDER BY rowid DESC LIMIT ?",
      )
      .all(botId, botId, scopeKey, root, before ?? null, before ?? null, limit + 1)
      .map((row) => this.get(String(row.id)) as CheckpointRecord);
  }
  create(value: CheckpointRecord) {
    transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO file_checkpoints(id,bot_id,run_id,scope_key,root,identity_json,state,version,truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          value.id,
          value.botId,
          value.runId,
          value.scopeKey,
          value.root,
          JSON.stringify(value.identity),
          value.state,
          value.version,
          Number(value.truncated),
          value.createdAt,
        );
      const put = this.db.prepare(
        "INSERT INTO file_checkpoint_items(id,checkpoint_id,path,kind,before_json,after_json,reason) VALUES (?,?,?,?,?,?,?)",
      );
      for (const item of value.items) {
        const image = value.images.get(item.id);
        put.run(
          item.id,
          value.id,
          item.path,
          item.kind,
          image?.before ? JSON.stringify(image.before) : null,
          image?.after ? JSON.stringify(image.after) : null,
          item.reason,
        );
      }
    });
  }
  imageBytes(value: CheckpointRecord | undefined) {
    const blobs = new Map<string, number>();
    for (const pair of value?.images.values() ?? [])
      for (const image of [pair.before, pair.after]) if (image) blobs.set(image.blob, image.bytes);
    return [...blobs.values()].reduce((sum, bytes) => sum + bytes, 0);
  }
  /** Distinct stored images per checkpoint; alternatives contain hashes, never extra blobs. */
  reservedBytes() {
    return Number(
      this.db
        .prepare(`SELECT coalesce(sum(bytes),0) AS n FROM (
      SELECT checkpoint_id, json_extract(image,'$.blob') AS blob,
        max(json_extract(image,'$.bytes')) AS bytes FROM (
          SELECT checkpoint_id,before_json AS image FROM file_checkpoint_items
          UNION ALL SELECT checkpoint_id,after_json FROM file_checkpoint_items
        ) WHERE image IS NOT NULL GROUP BY checkpoint_id,blob
      )`)
        .get()?.n ?? 0,
    );
  }
  /** A prepared Office item and a drained ordinary item share one checkpoint per run/root. */
  merge(value: CheckpointRecord) {
    transaction(this.db, () => {
      const previous = this.forRun(value.runId, value.root);
      if (!previous) {
        this.create(value);
        return;
      }
      if (
        previous.botId !== value.botId ||
        previous.scopeKey !== value.scopeKey ||
        previous.identity.device !== value.identity.device ||
        previous.identity.inode !== value.identity.inode
      )
        throw new Error("checkpoint_identity_changed");
      const put = this.db.prepare(`INSERT INTO file_checkpoint_items
        (id,checkpoint_id,path,kind,before_json,after_json,reason) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(checkpoint_id,path) DO UPDATE SET
        before_json=coalesce(file_checkpoint_items.before_json,excluded.before_json),
        after_json=excluded.after_json,reason=excluded.reason`);
      for (const item of value.items) {
        const image = value.images.get(item.id);
        put.run(
          item.id,
          previous.id,
          item.path,
          item.kind,
          image?.before ? JSON.stringify(image.before) : null,
          image?.after ? JSON.stringify(image.after) : null,
          item.reason,
        );
      }
      this.db
        .prepare(
          "UPDATE file_checkpoints SET version=version+1,state=CASE WHEN EXISTS (SELECT 1 FROM file_checkpoint_items WHERE checkpoint_id=? AND reason IS NOT NULL) THEN 'partial' ELSE 'available' END WHERE id=?",
        )
        .run(previous.id, previous.id);
    });
  }
  /** Never discard unresolved recovery evidence; expired rows remain as visible history. */
  expireBefore(cutoff: string, activeRuns: string[]) {
    const rows = this.db
      .prepare(`SELECT id,bot_id AS botId,run_id AS runId FROM file_checkpoints c
      WHERE state<>'expired' AND created_at<? AND NOT EXISTS
      (SELECT 1 FROM file_restore_operations r WHERE r.checkpoint_id=c.id AND r.state IN ('intent','running','interrupted'))
      ORDER BY created_at LIMIT 200`)
      .all(cutoff);
    const expired = rows.filter((row) => !activeRuns.includes(String(row.runId)));
    transaction(this.db, () => {
      for (const row of expired) {
        this.db
          .prepare(
            "UPDATE file_checkpoint_items SET before_json=NULL,after_json=NULL,reason='snapshot_missing' WHERE checkpoint_id=?",
          )
          .run(String(row.id));
        this.db
          .prepare("UPDATE file_checkpoints SET state='expired',version=version+1 WHERE id=?")
          .run(String(row.id));
      }
    });
    return expired.map((row) => ({ id: String(row.id), botId: String(row.botId) }));
  }
  restore(id: string): FileRestore | undefined {
    const row = this.db
      .prepare(
        "SELECT id,checkpoint_id AS checkpointId,state,recovery_path AS recoveryPath,created_at AS createdAt,updated_at AS updatedAt FROM file_restore_operations WHERE id=?",
      )
      .get(id);
    if (!row) return undefined;
    const items = this.db
      .prepare(
        "SELECT item_id AS itemId,state,reason FROM file_restore_items WHERE restore_id=? ORDER BY item_id LIMIT 500",
      )
      .all(id);
    return FileRestoreSchema.parse({
      ...row,
      items: items.map((item) => ({
        ...item,
        reason:
          item.reason ??
          (item.state === "conflict"
            ? "file_changed"
            : item.state === "interrupted"
              ? "recovery_interrupted"
              : null),
      })),
    });
  }
  restores(checkpointId: string, limit: number, before?: string) {
    return this.db
      .prepare(
        "SELECT id FROM file_restore_operations WHERE checkpoint_id=? AND (? IS NULL OR rowid<(SELECT rowid FROM file_restore_operations WHERE id=?)) ORDER BY rowid DESC LIMIT ?",
      )
      .all(checkpointId, before ?? null, before ?? null, limit + 1)
      .map((row) => this.restore(String(row.id)) as FileRestore);
  }
  intent(value: FileRestore) {
    transaction(this.db, () => {
      const checkpoint = this.get(value.checkpointId);
      if (!checkpoint || checkpoint.state === "expired") throw new Error("checkpoint_stale");
      this.db
        .prepare(
          "INSERT INTO file_restore_operations(id,checkpoint_id,state,recovery_path,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          value.id,
          value.checkpointId,
          value.state,
          value.recoveryPath,
          value.createdAt,
          value.updatedAt,
        );
      const put = this.db.prepare(
        "INSERT INTO file_restore_items(restore_id,item_id,state) VALUES (?,?,?)",
      );
      for (const item of value.items) put.run(value.id, item.itemId, item.state);
    });
  }
  item(
    restoreId: string,
    itemId: string,
    state: FileRestore["items"][number]["state"],
    reason?: FileRestore["items"][number]["reason"],
  ) {
    this.db
      .prepare("UPDATE file_restore_items SET state=?,reason=? WHERE restore_id=? AND item_id=?")
      .run(state, reason ?? null, restoreId, itemId);
  }
  finishPending(id: string) {
    this.db
      .prepare(
        "UPDATE file_restore_items SET state='interrupted' WHERE restore_id=? AND state='pending'",
      )
      .run(id);
  }
  settle(id: string, state: FileRestore["state"]) {
    this.db
      .prepare("UPDATE file_restore_operations SET state=?,updated_at=? WHERE id=?")
      .run(state, new Date().toISOString(), id);
  }
}
