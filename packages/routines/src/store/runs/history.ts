import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type ActivityCountQuery,
  type RoutineHistoryQuery,
  RoutineHistoryQuerySchema,
  RoutineHistoryViewSchema,
} from "@pibot/protocol";

// Project only public run fields: drafts, ownership tokens and SDK files are never read here.
const columns = `r.id,r.routine_id AS routineId,r.bot_id AS botId,r.trigger_id AS triggerId,
  r.reason,r.scheduled_for AS scheduledFor,r.queued_at AS queuedAt,r.queue_expires_at AS queueExpiresAt,
  r.max_duration_min AS maxDurationMin,r.started_at AS startedAt,r.finished_at AS finishedAt,
  r.status,r.run_id AS runId,r.conversation_id AS conversationId,r.trigger_message_id AS triggerMessageId,
  r.error_code AS errorCode,r.summary,r.allowed_ops AS allowedOps,r.active_ms AS activeMs,
  r.waiting_ms AS waitingMs,r.active_since AS activeSince,r.waiting_since AS waitingSince,
  r.wait_expires_at AS waitExpiresAt,r.created_at AS createdAt,
  t.name AS taskName,t.deleted_at AS taskDeletedAt,b.name AS botName,
  b.avatar_shape AS avatarShape,b.avatar_color AS avatarColor,b.avatar_eyes AS avatarEyes,
  b.archived_at AS archivedAt,
  (SELECT value FROM settings WHERE key='avatar:bot:' || b.id) AS avatarImage`;

export function routineHistoryCount(
  db: DatabaseSync,
  query: Pick<ActivityCountQuery, "botId" | "from">,
) {
  const predicates: string[] = [];
  const args: SQLInputValue[] = [];
  if (query.botId) {
    predicates.push("bot_id=?");
    args.push(query.botId);
  }
  if (query.from) {
    predicates.push("created_at>=?");
    args.push(query.from);
  }
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM routine_runs ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}`,
      )
      .get(...args)?.n ?? 0,
  );
}

export function routineHistory(db: DatabaseSync, input: RoutineHistoryQuery) {
  const query = RoutineHistoryQuerySchema.parse(input);
  const predicates: string[] = [];
  const values: SQLInputValue[] = [];
  if (query.botId) {
    predicates.push("r.bot_id=?");
    values.push(query.botId);
  }
  if (query.from) {
    predicates.push("r.created_at>=?");
    values.push(query.from);
  }
  if (query.ids) {
    predicates.push(`r.id IN (${query.ids.map(() => "?").join(",")})`);
    values.push(...query.ids);
  }
  if (query.before) {
    const cursor = db
      .prepare("SELECT created_at AS at,bot_id AS botId FROM routine_runs WHERE id=?")
      .get(query.before);
    if (
      !cursor ||
      (query.botId && cursor.botId !== query.botId) ||
      (query.from && String(cursor.at) < query.from)
    )
      return [];
    predicates.push("(r.created_at<? OR (r.created_at=? AND r.id<?))");
    values.push(String(cursor.at), String(cursor.at), query.before);
  }
  return db
    .prepare(`SELECT ${columns} FROM routine_runs r
    LEFT JOIN routines t ON t.id=r.routine_id LEFT JOIN bots b ON b.id=r.bot_id
    ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
    ORDER BY r.created_at DESC,r.id DESC LIMIT ?`)
    .all(...values, query.limit ?? (query.ids ? 200 : 50))
    .map((row) => {
      const {
        taskDeletedAt,
        botName,
        avatarShape,
        avatarColor,
        avatarEyes,
        archivedAt,
        avatarImage,
        ...run
      } = row;
      return RoutineHistoryViewSchema.parse({
        ...run,
        allowedOps: JSON.parse(String(run.allowedOps)),
        taskDeleted: taskDeletedAt !== null,
        bot:
          botName == null
            ? null
            : {
                name: botName,
                avatarShape,
                avatarColor,
                avatarEyes,
                archivedAt,
                ...(typeof avatarImage === "string"
                  ? { avatarImage: JSON.parse(avatarImage) }
                  : {}),
              },
      });
    });
}
