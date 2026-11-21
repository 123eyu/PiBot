import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { extractionAutomatedReason } from "./memory-extraction-origin.ts";

export { memoryHumanMessageSql } from "./memory-extraction-origin.ts";

import { transaction } from "../database/database.ts";

/**
 * The post-hoc extraction queue. Rows are the durable work items; the unique open index in
 * migration 0135 makes enqueueing idempotent and `recover` puts a crash-interrupted run back in the
 * queue instead of losing it.
 */
export type MemoryExtractionStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface MemoryExtraction {
  id: string;
  botId: string;
  conversationId: string;
  groupId: string | null;
  status: MemoryExtractionStatus;
  reason: "idle" | "archive";
  coverageMessageId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  tokens: number;
  costUsd: number;
  candidates: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ExtractionTopic {
  conversationId: string;
  botId: string;
  groupId: string | null;
  lastMessageId: string;
  lastUserId: string;
  lastAt: string;
}

const columns = `id, bot_id AS botId, conversation_id AS conversationId, group_id AS groupId,
  status, reason, coverage_message_id AS coverageMessageId, model_provider AS modelProvider,
  model_id AS modelId, tokens, cost_usd AS costUsd, candidates, error, created_at AS createdAt,
  started_at AS startedAt, finished_at AS finishedAt`;

function row(value: Record<string, unknown>): MemoryExtraction {
  return {
    id: String(value.id),
    botId: String(value.botId),
    conversationId: String(value.conversationId),
    groupId: value.groupId == null ? null : String(value.groupId),
    status: value.status as MemoryExtractionStatus,
    reason: value.reason as "idle" | "archive",
    coverageMessageId: value.coverageMessageId == null ? null : String(value.coverageMessageId),
    modelProvider: value.modelProvider == null ? null : String(value.modelProvider),
    modelId: value.modelId == null ? null : String(value.modelId),
    tokens: Number(value.tokens ?? 0),
    costUsd: Number(value.costUsd ?? 0),
    candidates: Number(value.candidates ?? 0),
    error: value.error == null ? null : String(value.error),
    createdAt: String(value.createdAt),
    startedAt: value.startedAt == null ? null : String(value.startedAt),
    finishedAt: value.finishedAt == null ? null : String(value.finishedAt),
  };
}

export class MemoryExtractionsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** A crash left rows running; they go back to the queue so the next start picks them up. */
  recover(): void {
    const interrupted = this.db
      .prepare(`SELECT ${columns} FROM memory_extractions WHERE status='running'`)
      .all();
    for (const value of interrupted) this.defer(row(value), "restart_interrupted");
  }

  enqueue(input: {
    botId: string;
    conversationId: string;
    groupId?: string | null;
    reason: "idle" | "archive";
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO memory_extractions
        (id, bot_id, conversation_id, group_id, status, reason, created_at)
        SELECT ?,?,?,?, 'queued', ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_extractions WHERE conversation_id=? AND status IN ('queued','running')
        )`,
      )
      .run(
        randomUUID(),
        input.botId,
        input.conversationId,
        input.groupId ?? null,
        input.reason,
        new Date().toISOString(),
        input.conversationId,
      );
    return result.changes > 0;
  }

  /**
   * Oldest queued row not owned by a Bot that already reached today's topic cap. The caps are
   * applied by the caller so rows stay queued (not failed) until the next day.
   */
  claim(excludedBotIds: readonly string[], now = new Date().toISOString()) {
    return transaction(this.db, () => {
      const excluded = excludedBotIds.length
        ? `AND bot_id NOT IN (${excludedBotIds.map(() => "?").join(",")})`
        : "";
      const found = this.db
        .prepare(
          `SELECT ${columns} FROM memory_extractions
          WHERE status='queued' ${excluded}
          ORDER BY CASE WHEN EXISTS (SELECT 1 FROM conversations c
            WHERE c.id=memory_extractions.conversation_id AND c.archived_at IS NOT NULL)
            THEN 0 ELSE 1 END,
            (SELECT m.created_at FROM messages m WHERE m.conversation_id=memory_extractions.conversation_id
              ORDER BY m.rowid DESC LIMIT 1) DESC, created_at, id LIMIT 1`,
        )
        .get(...excludedBotIds);
      if (!found) return undefined;
      const value = row(found);
      const changed = this.db
        .prepare(
          `UPDATE memory_extractions SET status='running', started_at=?
          WHERE id=? AND status='queued'`,
        )
        .run(now, value.id);
      return changed.changes ? { ...value, status: "running" as const, startedAt: now } : undefined;
    });
  }

  skipQueued(conversationId: string, reason: string, coverageMessageId: string | null) {
    this.db
      .prepare(`UPDATE memory_extractions SET status='skipped', error=?,
      coverage_message_id=?, finished_at=? WHERE conversation_id=? AND status='queued'`)
      .run(reason, coverageMessageId, new Date().toISOString(), conversationId);
  }

  recordUsage(
    id: string,
    usage: { tokens: number; costUsd?: number; modelProvider: string; modelId: string },
  ) {
    this.db
      .prepare(`UPDATE memory_extractions SET tokens=?, cost_usd=?, model_provider=?, model_id=?
      WHERE id=? AND status='running'`)
      .run(usage.tokens, usage.costUsd ?? 0, usage.modelProvider, usage.modelId, id);
  }

  diagnostics(
    id: string,
    counts: {
      raw: number;
      valid: number;
      applied: number;
      proposed: number;
      reasons: Record<string, number>;
    },
  ) {
    this.db
      .prepare(`UPDATE memory_extractions SET raw_candidates=?, valid_candidates=?,
      applied_candidates=?, proposed_candidates=?, reason_counts=? WHERE id=?`)
      .run(
        counts.raw,
        counts.valid,
        counts.applied,
        counts.proposed,
        JSON.stringify(counts.reasons),
        id,
      );
  }

  /** Keep the billed attempt, create a fresh durable work item; cancellation never refunds usage. */
  defer(value: MemoryExtraction, reason: string) {
    transaction(this.db, () => {
      const usage = this.db
        .prepare("SELECT tokens FROM memory_extractions WHERE id=?")
        .get(value.id);
      if (!Number(usage?.tokens)) {
        this.db
          .prepare(`UPDATE memory_extractions SET status='queued', started_at=NULL,
          error=? WHERE id=? AND status='running'`)
          .run(reason, value.id);
        return;
      }
      this.finish(value.id, { status: "failed", error: reason });
      this.enqueue({ ...value, reason: value.reason });
    });
  }

  automatedReason(conversationId: string) {
    return extractionAutomatedReason(this.db, conversationId);
  }

  finish(
    id: string,
    patch: {
      status: "done" | "failed" | "skipped";
      coverageMessageId?: string | null;
      modelProvider?: string | null;
      modelId?: string | null;
      tokens?: number;
      costUsd?: number;
      candidates?: number;
      error?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE memory_extractions SET status=?, coverage_message_id=?, model_provider=COALESCE(?,model_provider),
        model_id=COALESCE(?,model_id), tokens=COALESCE(?,tokens), cost_usd=COALESCE(?,cost_usd), candidates=?, error=?, finished_at=?
        WHERE id=? AND status='running'`,
      )
      .run(
        patch.status,
        patch.coverageMessageId ?? null,
        patch.modelProvider ?? null,
        patch.modelId ?? null,
        patch.tokens ?? null,
        patch.costUsd ?? null,
        patch.candidates ?? 0,
        patch.error ?? null,
        new Date().toISOString(),
        id,
      );
  }

  /** The newest message the topic has; used as the coverage watermark after a run. */
  watermark(conversationId: string) {
    const last = this.db
      .prepare(
        "SELECT id, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(conversationId);
    const user = this.db
      .prepare(
        `SELECT id FROM messages WHERE conversation_id=? AND role='user' AND status='done'
        ORDER BY rowid DESC LIMIT 1`,
      )
      .get(conversationId);
    return last
      ? {
          messageId: String(last.id),
          lastAt: String(last.createdAt),
          lastUserId: user ? String(user.id) : null,
        }
      : undefined;
  }

  /**
   * Topics that are ready for extraction. A topic is due when it was archived or its last message
   * is older than the idle cutoff; it needs two user messages, an enabled Bot, and no extraction
   * that already covered its newest message. Failed/skipped attempts wait an hour and stop after
   * three failures in a day so a broken model cannot loop.
   */
  dueTopics(idleBefore: string, retryAfter: string, failedSince: string, limit = 100) {
    const rows = this.db
      .prepare(
        `WITH t AS (
          SELECT c.id AS conversationId,
            COALESCE(c.bot_id, g.coordinator_bot_id) AS botId,
            c.group_id AS groupId,
            c.archived_at AS archivedAt,
            (SELECT m.id FROM messages m WHERE m.conversation_id=c.id
              ORDER BY m.rowid DESC LIMIT 1) AS lastMessageId,
            (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id
              ORDER BY m.rowid DESC LIMIT 1) AS lastAt,
            (SELECT m.id FROM messages m WHERE m.conversation_id=c.id AND m.role='user'
              AND m.status='done' ORDER BY m.rowid DESC LIMIT 1) AS lastUserId,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.role='user'
              AND m.status='done') AS userCount
          FROM conversations c LEFT JOIN groups g ON g.id=c.group_id
          WHERE c.kind IN ('dm','group')
        )
        SELECT t.conversationId, t.botId, t.groupId, t.lastMessageId, t.lastUserId, t.lastAt
        FROM t JOIN bots b ON b.id=t.botId AND b.memory_extraction=1 AND b.archived_at IS NULL
        WHERE t.userCount>=2 AND t.lastMessageId IS NOT NULL
          AND (t.archivedAt IS NOT NULL OR t.lastAt<=?)
          AND NOT EXISTS (
            SELECT 1 FROM memory_extractions e WHERE e.conversation_id=t.conversationId
              AND (((e.status='done' OR (e.status='skipped' AND e.error LIKE 'automation_%')) AND e.coverage_message_id=t.lastMessageId)
                OR e.status IN ('queued','running')
                OR (e.status IN ('failed','skipped') AND e.finished_at>?))
          )
          AND (SELECT COUNT(*) FROM memory_extractions e2
            WHERE e2.conversation_id=t.conversationId AND e2.status='failed'
              AND e2.started_at>?)<3
        ORDER BY (t.archivedAt IS NOT NULL) DESC, t.lastAt DESC LIMIT ?`,
      )
      .all(idleBefore, retryAfter, failedSince, limit);
    return rows.map((value) => ({
      conversationId: String(value.conversationId),
      botId: String(value.botId),
      groupId: value.groupId == null ? null : String(value.groupId),
      lastMessageId: String(value.lastMessageId),
      lastUserId: String(value.lastUserId),
      lastAt: String(value.lastAt),
    })) satisfies ExtractionTopic[];
  }

  /** Attempts started today, including failures: the cap protects both cost and time. */
  todayByBot(since: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT bot_id AS botId, COUNT(*) AS n FROM memory_extractions
        WHERE started_at>=? AND status IN ('running','done','failed') GROUP BY bot_id`,
      )
      .all(since);
    return new Map(rows.map((value) => [String(value.botId), Number(value.n)]));
  }

  costSince(since: string): number {
    const value = this.db
      .prepare("SELECT IFNULL(SUM(cost_usd),0) AS cost FROM memory_extractions WHERE started_at>=?")
      .get(since);
    return Number(value?.cost ?? 0);
  }

  /** Usage statistics read this, so extraction cost is visible next to chat runs. */
  usageSince(since: string) {
    const value = this.db
      .prepare(
        `SELECT COUNT(*) AS topics, IFNULL(SUM(tokens),0) AS tokens,
        IFNULL(SUM(cost_usd),0) AS costUsd, IFNULL(SUM(candidates),0) AS candidates
        FROM memory_extractions WHERE started_at>=? AND status IN ('done','failed')`,
      )
      .get(since);
    return {
      topics: Number(value?.topics ?? 0),
      tokens: Number(value?.tokens ?? 0),
      costUsd: Number(value?.costUsd ?? 0),
      candidates: Number(value?.candidates ?? 0),
    };
  }

  /** Pending work survives a restart; the queue is drained oldest-first on the next start. */
  pending(): number {
    const value = this.db
      .prepare("SELECT COUNT(*) AS n FROM memory_extractions WHERE status IN ('queued','running')")
      .get();
    return Number(value?.n ?? 0);
  }
}
