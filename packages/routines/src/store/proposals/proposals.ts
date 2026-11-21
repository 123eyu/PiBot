import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type Page,
  type RoutineDraftInput,
  RoutineDraftSchema,
  RoutineProposalPayloadSchema,
  RoutineProposalSchema,
  type WorkspaceSnapshot,
} from "@pibot/protocol";
import { readPage, transaction } from "@pibot/storage";
import { RoutinesRepo } from "../definitions/routines.ts";

const columns =
  "id,bot_id AS botId,message_id AS messageId,payload,status,resolved_routine_id AS resolvedRoutineId,dedupe_key AS dedupeKey,created_at AS createdAt,resolved_at AS resolvedAt";
function parse(row: Record<string, unknown>) {
  return RoutineProposalSchema.parse({ ...row, payload: JSON.parse(String(row.payload)) });
}
export class RoutineProposalsRepo {
  constructor(private readonly db: DatabaseSync) {}
  require(id: string) {
    const value = this.get(id);
    if (!value) throw new TypeError("Missing persisted record");
    return value;
  }
  get(id: string) {
    const r = this.db
      .prepare(`SELECT ${columns} FROM routine_proposals WHERE id=?`)
      .get(IdSchema.parse(id));
    return r ? parse(r) : undefined;
  }
  list(
    query: {
      botId?: string;
      messageId?: string;
      status?: "open" | "accepted" | "declined" | "expired";
    } = {},
    page: Page = {},
  ) {
    const scope: [string, string][] = query.botId ? [["bot_id", IdSchema.parse(query.botId)]] : [];
    if (query.messageId) scope.push(["message_id", IdSchema.parse(query.messageId)]);
    if (query.status) RoutineProposalSchema.shape.status.parse(query.status);
    return readPage(
      this.db,
      "routine_proposals",
      columns,
      "created_at",
      page,
      [...scope, ...(query.status ? [["status", query.status] as [string, string]] : [])],
      scope,
    ).map(parse);
  }
  create(input: { botId: string; messageId: string | null; payload: unknown; dedupeKey: string }) {
    const p = RoutineProposalSchema.parse({
      ...input,
      payload: RoutineProposalPayloadSchema.parse(input.payload),
      id: randomUUID(),
      status: "open",
      resolvedRoutineId: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    return transaction(this.db, () => {
      const existing = this.db
        .prepare(`SELECT ${columns} FROM routine_proposals WHERE dedupe_key=?`)
        .get(p.dedupeKey);
      if (existing) {
        const old = parse(existing);
        if (
          old.botId !== p.botId ||
          old.messageId !== p.messageId ||
          JSON.stringify(old.payload) !== JSON.stringify(p.payload)
        )
          throw new TypeError("Proposal dedupe identity conflict");
        return old;
      }
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM routine_proposals WHERE bot_id=? AND status='open'")
        .get(p.botId);
      const messageCount = this.db
        .prepare("SELECT COUNT(*) AS n FROM routine_proposals WHERE message_id=?")
        .get(p.messageId);
      if (Number(count?.n) >= 64 || Number(messageCount?.n) >= 20)
        throw new TypeError("Proposal quota exceeded");
      if (!this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(p.botId))
        throw new TypeError("Unknown or archived Bot");
      if (
        p.messageId &&
        !this.db
          .prepare("SELECT 1 FROM messages WHERE id=? AND bot_id=? AND role='assistant'")
          .get(p.messageId, p.botId)
      )
        throw new TypeError("Wrong proposal message");
      if (p.payload.routineId) {
        const r = new RoutinesRepo(this.db).get(p.payload.routineId);
        if (!r || r.deletedAt || r.botId !== p.botId) throw new TypeError("Wrong proposed routine");
        if (!p.payload.expectedVersion || r.version !== p.payload.expectedVersion)
          throw new TypeError("Modification requires current expected version");
      }
      this.db
        .prepare(
          "INSERT INTO routine_proposals(id,bot_id,message_id,payload,status,dedupe_key,created_at) VALUES (?,?,?,?,'open',?,?)",
        )
        .run(p.id, p.botId, p.messageId, JSON.stringify(p.payload), p.dedupeKey, p.createdAt);
      return p;
    });
  }
  // The service validates user confirmation or scoped YOLO acceptance; this primitive grants no authority.
  resolve(
    id: string,
    accept: boolean,
    validatedDraft?: RoutineDraftInput,
    snapshot: WorkspaceSnapshot | null = null,
  ) {
    return transaction(this.db, () => {
      const p = this.get(id);
      if (!p) throw new TypeError("Unknown proposal");
      const routines = new RoutinesRepo(this.db);
      if (p.status !== "open") {
        if (p.status !== (accept ? "accepted" : "declined"))
          throw new TypeError("Proposal already resolved");
        return {
          proposal: p,
          routine: p.resolvedRoutineId ? (routines.get(p.resolvedRoutineId) ?? null) : null,
        };
      }
      let routine = null;
      let payload = p.payload;
      if (accept) {
        // The service resolves missing fields, verifies current folder/policy ceilings, and passes the full draft.
        const draft = RoutineDraftSchema.parse(validatedDraft);
        payload = RoutineProposalPayloadSchema.parse({ ...p.payload, acceptedDraft: draft });
        routine = p.payload.routineId
          ? routines.update(p.payload.routineId, draft, p.payload.expectedVersion ?? 0, snapshot)
          : routines.create(draft, snapshot);
      }
      this.db
        .prepare(
          "UPDATE routine_proposals SET status=?,resolved_routine_id=?,resolved_at=?,payload=? WHERE id=? AND status='open'",
        )
        .run(
          accept ? "accepted" : "declined",
          routine?.id ?? null,
          new Date().toISOString(),
          JSON.stringify(payload),
          id,
        );
      return { proposal: this.require(id), routine };
    });
  }
  expireStale() {
    // Bounded retirement also returns each Bot identity for safe per-proposal audit.
    return this.db
      .prepare(`UPDATE routine_proposals SET status='expired',resolved_at=? WHERE id IN (
      SELECT p.id FROM routine_proposals p WHERE p.status='open' AND (
        NOT EXISTS (SELECT 1 FROM bots b WHERE b.id=p.bot_id AND b.archived_at IS NULL)
        OR (json_extract(p.payload,'$.routineId') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM routines r WHERE r.id=json_extract(p.payload,'$.routineId') AND r.deleted_at IS NULL
          AND r.bot_id=p.bot_id AND r.version=json_extract(p.payload,'$.expectedVersion')
        ))) LIMIT 200) RETURNING ${columns}`)
      .all(new Date().toISOString())
      .map(parse);
  }
  expire(id: string) {
    return (
      this.db
        .prepare(
          "UPDATE routine_proposals SET status='expired',resolved_at=? WHERE id=? AND status='open'",
        )
        .run(new Date().toISOString(), IdSchema.parse(id)).changes > 0
    );
  }
}
