import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type ActivityCountQuery,
  ActivityCountQuerySchema,
  AuditCountBucketSchema,
  CategorySchema,
  legacyInternalConnectorSummaries,
} from "@pibot/protocol-base";

/** Historical automatic captures used the command kind; project them without rewriting history. */
export const auditKindSql = `CASE WHEN kind='exec.finished'
  AND json_extract(detail,'$.toolName')='managed.checkpoint_create'
  THEN 'file.checkpoint' ELSE kind END`;

/** List and count must resolve group ownership identically, including legacy task records. */
export const auditGroupSql = `CASE WHEN run_id IS NOT NULL THEN
  (SELECT r.group_id FROM runs r WHERE r.id=audit_log.run_id) ELSE COALESCE(
  (SELECT t.group_id FROM group_tasks t WHERE t.id=json_extract(audit_log.detail,'$.taskId')),
  json_extract(audit_log.detail,'$.groupId')) END`;

/** One grouped statement, independent of the selected category and of loaded history pages. */
export function auditCounts(db: DatabaseSync, input: ActivityCountQuery) {
  const query = ActivityCountQuerySchema.parse(input);
  const args: SQLInputValue[] = [];
  const scope = (bot: string, group: string, time: string) => {
    const where: string[] = [];
    for (const [expression, value, comparison] of [
      [bot, query.botId, "="],
      [group, query.groupId, "="],
      [time, query.from, ">="],
    ] as const)
      if (value !== undefined) {
        where.push(`${expression}${comparison}?`);
        args.push(value);
      }
    return where.length ? `WHERE ${where.join(" AND ")}` : "";
  };
  const auditScope = scope("bot_id", auditGroupSql, "at");
  const computerScope = scope(
    "bot_id",
    "(SELECT r.group_id FROM runs r WHERE r.id=computer_steps.run_id)",
    "created_at",
  );
  const backgroundScope = scope("bot_id", "group_id", "COALESCE(ended_at,started_at)");
  // These are protocol constants, bound as parameters rather than interpolated into SQL.
  const categories = CategorySchema.options;
  const markers = legacyInternalConnectorSummaries;
  return db
    .prepare(`WITH records AS (
    SELECT 'audit' AS source, ${auditKindSql} AS kind,
      CASE WHEN json_extract(detail,'$.category') IN (${categories.map(() => "?").join(",")})
        THEN json_extract(detail,'$.category') ELSE NULL END AS category,
      CASE WHEN json_extract(detail,'$.internal')=1
        OR kind='delivery.evidence'
        OR (kind='exec.finished' AND json_extract(detail,'$.toolName')='delivery_evidence')
        OR kind IN ('tool.journal.started','tool.journal.finished')
        OR (kind IN ('connector.changed','plugin.changed') AND summary IN (${markers.map(() => "?").join(",")}))
        OR json_extract(detail,'$.collaborationAction')='completion_wake'
        OR (kind='collaboration.queued' AND json_extract(detail,'$.collaborationAction') IS NULL
          AND json_extract(detail,'$.taskId') IS NOT NULL AND json_extract(detail,'$.childRunId') IS NOT NULL
          AND json_extract(detail,'$.toolCallId') IS NULL)
        THEN 1 ELSE 0 END AS internal
      FROM audit_log ${auditScope}
    UNION ALL SELECT 'computer',NULL,NULL,0 FROM computer_steps ${computerScope}
    UNION ALL SELECT 'background',NULL,NULL,0 FROM background_commands ${backgroundScope}
  ) SELECT source,kind,category,internal,COUNT(*) AS count FROM records
    GROUP BY source,kind,category,internal`)
    .all(...categories, ...markers, ...args)
    .map((row) => AuditCountBucketSchema.parse({ ...row, internal: row.internal === 1 }));
}
