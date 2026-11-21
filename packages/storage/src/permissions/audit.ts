import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ActivityCountQuery,
  type AuditEntry,
  AuditEntrySchema,
  type AuditQuery,
  AuditQuerySchema,
} from "@pibot/protocol-base";
import type { Redactor } from "@pibot/secrets";
import { readPage } from "../database/paging.ts";
import { auditCounts, auditGroupSql, auditKindSql } from "./audit-counts.ts";

const retentionMs = 90 * 24 * 60 * 60 * 1000;
const columns = `id, at, bot_id AS botId, ${auditKindSql} AS kind, summary, detail, run_id AS runId`;
function parseEntry(row: Record<string, unknown>): AuditEntry {
  return AuditEntrySchema.parse({ ...row, detail: JSON.parse(String(row.detail)) });
}

export class AuditRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly redactor: Pick<Redactor, "redact">,
  ) {
    this.cleanup();
  }

  append(input: Omit<AuditEntry, "id" | "at" | "runId"> & { runId?: string | null }): AuditEntry {
    const entry = AuditEntrySchema.parse({
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
      runId: input.runId ?? null,
    });
    entry.summary = this.redactor.redact(entry.summary);
    // Redact JSON string leaves instead of serialized JSON, so escaping cannot break masking or JSON syntax.
    entry.detail = AuditEntrySchema.shape.detail.parse(redactJson(entry.detail, this.redactor));
    this.db
      .prepare(
        `INSERT INTO audit_log(id, at, bot_id, kind, summary, detail, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.at,
        entry.botId,
        entry.kind,
        entry.summary,
        JSON.stringify(entry.detail),
        entry.runId,
      );
    return entry;
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    const { botId, groupId, kind, ...page } = AuditQuerySchema.parse(query);
    const filters: [string, string][] = [];
    if (botId !== undefined) filters.push(["bot_id", botId]);
    if (kind !== undefined) {
      // Preserve the kind index for ordinary records; only checkpoints need legacy projection.
      if (kind !== "file.checkpoint") filters.push(["kind", kind]);
      if (kind === "file.checkpoint" || kind === "exec.finished")
        filters.push([auditKindSql, kind]);
    }
    if (groupId !== undefined) filters.push([auditGroupSql, groupId]);
    return readPage(this.db, "audit_log", columns, "at", page, filters).map(parseEntry);
  }

  counts(query: ActivityCountQuery) {
    return auditCounts(this.db, query);
  }

  hasRunReason(runId: string, kind: AuditEntry["kind"], reasonCode: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM audit_log WHERE run_id=? AND kind=? AND json_extract(detail,'$.reasonCode')=? LIMIT 1",
      )
      .get(runId, kind, reasonCode);
  }

  cleanup(now = new Date()): number {
    return Number(
      this.db
        .prepare("DELETE FROM audit_log WHERE at < ?")
        .run(new Date(now.getTime() - retentionMs).toISOString()).changes,
    );
  }
}

function redactJson(value: unknown, redactor: Pick<Redactor, "redact">): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redactor));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item, redactor)]),
    );
  }
  return value;
}
