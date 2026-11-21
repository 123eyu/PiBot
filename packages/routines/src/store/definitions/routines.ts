import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CanonicalTimeSchema,
  IdSchema,
  type Routine,
  RoutineCountsSchema,
  type RoutineDraftInput,
  RoutineDraftSchema,
  RoutineListQuerySchema,
  type RoutinePatch,
  RoutinePatchSchema,
  RoutineSchema,
  type WorkspaceSnapshot,
} from "@pibot/protocol";
import { ConversationsRepo, readPage, transaction } from "@pibot/storage";
import { RoutinePreauthRepo } from "./preauth.ts";
import { RoutineTriggersRepo } from "./triggers.ts";

const columns = `id,bot_id AS botId,name,instructions,workplace,notify,max_duration_min AS maxDurationMin,carry_last_result AS carryLastResult,output,workflow,missed_policy AS missedPolicy,enabled,paused_reason AS pausedReason,last_scheduled_at AS lastScheduledAt,topic_conversation_id AS topicConversationId,version,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt`;
export class RoutinesRepo {
  constructor(private readonly db: DatabaseSync) {}
  /**
   * Children of a whole page in two queries instead of two per routine: callers walk every routine
   * on hot paths (the 15 s scan, the 10 s host refresh, watcher sync, away check).
   */
  private parse(rows: Record<string, unknown>[]): Routine[] {
    const ids = rows.map((row) => String(row.id));
    const triggers = new RoutineTriggersRepo(this.db).forRoutines(ids);
    const invalid = new Set<string>();
    const preauth = new RoutinePreauthRepo(this.db).forRoutines(ids, invalid);
    return rows.map((row) =>
      RoutineSchema.parse({
        ...row,
        workplace: JSON.parse(String(row.workplace)),
        enabled: row.enabled === 1,
        carryLastResult: row.carryLastResult === 1,
        // Routines saved before migration 0071 read as the default artifact folder settings.
        output: row.output == null ? undefined : JSON.parse(String(row.output)),
        workflow: row.workflow == null ? null : JSON.parse(String(row.workflow)),
        triggers: triggers.get(String(row.id)) ?? [],
        // Never expose a partially parsed set as usable consent. The task remains editable.
        preauth: invalid.has(String(row.id)) ? [] : (preauth.get(String(row.id)) ?? []),
        ...(invalid.has(String(row.id))
          ? { authorizationError: "routine_preauth_reauthorization_required" }
          : {}),
      }),
    );
  }
  require(id: string) {
    const value = this.get(id);
    if (!value) throw new TypeError("Missing persisted record");
    return value;
  }
  get(id: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM routines WHERE id=?`)
      .get(IdSchema.parse(id));
    return row ? this.parse([row])[0] : undefined;
  }
  list(query: { botId?: string; before?: string; limit?: number; includeDeleted?: boolean } = {}) {
    const { botId, includeDeleted, ...page } = RoutineListQuerySchema.parse(query);
    const scope: [string, string | null][] = botId ? [["bot_id", botId]] : [];
    const rows = readPage(
      this.db,
      "routines",
      columns,
      "created_at",
      page,
      [...scope, ...(includeDeleted ? [] : [["deleted_at", null] as [string, null]])],
      scope,
    );
    return this.parse(rows);
  }
  counts() {
    // Counts are authoritative over the whole DB; next cron time is computed by scheduler, not a page.
    const routines = this.db
      .prepare(
        "SELECT COUNT(CASE WHEN enabled=1 AND paused_reason IS NULL AND b.archived_at IS NULL AND EXISTS (SELECT 1 FROM routine_triggers t WHERE t.routine_id=r.id AND t.deleted_at IS NULL AND (t.kind<>'once' OR json_extract(t.state,'$.consumedAt') IS NULL)) THEN 1 END) AS enabled,COUNT(CASE WHEN paused_reason='away_7d' THEN 1 END) AS awayPaused FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.deleted_at IS NULL",
      )
      .get();
    const runs = this.db
      .prepare(
        "SELECT COUNT(CASE WHEN status='scheduled' THEN 1 END) AS scheduled,COUNT(CASE WHEN status='running' THEN 1 END) AS running,COUNT(CASE WHEN status='waiting' THEN 1 END) AS waiting FROM routine_runs",
      )
      .get();
    return RoutineCountsSchema.parse({ ...routines, ...runs });
  }
  private validateOwner(botId: string, workplace: Routine["workplace"]) {
    if (!this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(botId))
      throw new TypeError("Unknown or archived Bot");
    if (workplace.kind === "folder") {
      const ids = [
        ...(workplace.folderId === "home" ? [] : [workplace.folderId]),
        ...(workplace.readonly ?? []),
        ...(workplace.cwd && workplace.cwd !== "home" ? [workplace.cwd] : []),
      ];
      // The folder is the routine's own primary; references are read-only.
      for (const id of ids)
        if (
          !this.db.prepare("SELECT 1 FROM working_folders WHERE id=? AND bot_id=?").get(id, botId)
        )
          throw new TypeError("Unknown routine workplace");
    }
  }
  /**
   * `adopt`: the conversation of a trial run of this draft becomes the task's topic instead of a
   * new one, so the trial and every later run share one topic. Only the same Bot's own, live,
   * not-yet-adopted chat qualifies; anything else falls back to a fresh topic.
   */
  create(input: RoutineDraftInput, snapshot: WorkspaceSnapshot | null = null, adopt?: string) {
    const draft = RoutineDraftSchema.parse(input);
    return transaction(this.db, () => {
      this.validateOwner(draft.botId, draft.workplace);
      const id = randomUUID(),
        now = new Date().toISOString();
      const adopted =
        adopt !== undefined &&
        this.db
          .prepare(
            "UPDATE conversations SET routine_id=?,title=? WHERE id=? AND kind='dm' AND bot_id=? AND routine_id IS NULL AND archived_at IS NULL AND internal_task_id IS NULL AND group_id IS NULL",
          )
          .run(id, draft.name, IdSchema.parse(adopt), draft.botId).changes === 1;
      const topic = adopted
        ? { id: adopt }
        : new ConversationsRepo(this.db).create({ botId: draft.botId });
      if (!adopted)
        this.db
          .prepare("UPDATE conversations SET routine_id=?,title=? WHERE id=?")
          .run(id, draft.name, topic.id);
      this.db
        .prepare(
          "INSERT INTO routines(id,bot_id,name,instructions,workplace,notify,max_duration_min,carry_last_result,output,workflow,missed_policy,enabled,topic_conversation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          draft.botId,
          draft.name,
          draft.instructions,
          JSON.stringify(draft.workplace),
          draft.notify,
          draft.maxDurationMin,
          Number(draft.carryLastResult),
          JSON.stringify(draft.output),
          draft.workflow ? JSON.stringify(draft.workflow) : null,
          draft.missedPolicy,
          Number(draft.enabled),
          topic.id,
          now,
          now,
        );
      new RoutineTriggersRepo(this.db).replace(id, draft.triggers);
      new RoutinePreauthRepo(this.db).replace(id, draft.preauth, snapshot);
      return this.require(id);
    });
  }
  update(
    id: string,
    patch: RoutinePatch,
    expectedVersion: number,
    snapshot: WorkspaceSnapshot | null = null,
  ) {
    const parsed = RoutinePatchSchema.parse(patch);
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current || current.deletedAt) throw new TypeError("Unknown routine");
      if (current.version !== expectedVersion) throw new TypeError("Routine version conflict");
      const changedBot = parsed.botId !== undefined && parsed.botId !== current.botId;
      if (
        changedBot &&
        this.db
          .prepare(
            "SELECT 1 FROM routine_runs WHERE routine_id=? AND status IN ('scheduled','running','waiting')",
          )
          .get(id)
      )
        throw new TypeError("Drain routine before changing Bot");
      const next = {
        ...current,
        ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)),
      };
      // A workflow binding names one Bot's skill; it does not follow the routine to another.
      if (changedBot && parsed.workflow === undefined) next.workflow = null;
      if (!next.workflow && !next.instructions.trim())
        throw new TypeError("Instructions required without workflow");
      this.validateOwner(next.botId, next.workplace);
      if (changedBot) {
        this.db
          .prepare("UPDATE conversations SET bot_id=?,pi_session_file=NULL WHERE id=?")
          .run(next.botId, current.topicConversationId);
        this.db
          .prepare("DELETE FROM bot_sessions WHERE conversation_id=?")
          .run(current.topicConversationId);
        this.db
          .prepare(
            "INSERT INTO sidebar_entries(conversation_key,bot_id) VALUES (?,?) ON CONFLICT DO NOTHING",
          )
          .run(`dm:${next.botId}`, next.botId);
        // Old Bot consent cannot become authority for the replacement Bot.
        new RoutinePreauthRepo(this.db).replace(id, []);
      }
      this.db
        .prepare(
          "UPDATE routines SET bot_id=?,name=?,instructions=?,workplace=?,notify=?,max_duration_min=?,carry_last_result=?,output=?,workflow=?,missed_policy=?,enabled=?,updated_at=?,version=version+1 WHERE id=? AND version=?",
        )
        .run(
          next.botId,
          next.name,
          next.instructions,
          JSON.stringify(next.workplace),
          next.notify,
          next.maxDurationMin,
          Number(next.carryLastResult),
          JSON.stringify(next.output),
          next.workflow ? JSON.stringify(next.workflow) : null,
          next.missedPolicy,
          Number(next.enabled),
          new Date().toISOString(),
          id,
          expectedVersion,
        );
      if (parsed.name)
        this.db
          .prepare("UPDATE conversations SET title=? WHERE id=?")
          .run(parsed.name, current.topicConversationId);
      if (parsed.triggers) new RoutineTriggersRepo(this.db).replace(id, parsed.triggers);
      if (parsed.preauth && !changedBot)
        new RoutinePreauthRepo(this.db).replace(id, parsed.preauth, snapshot);
      return this.require(id);
    });
  }
  setEnabled(id: string, enabled: boolean) {
    const r = this.get(id);
    if (!r) throw new TypeError("Unknown routine");
    return this.update(id, { enabled }, r.version);
  }
  softDelete(id: string) {
    return transaction(this.db, () => {
      const r = this.get(id);
      if (!r || r.deletedAt) return false;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM routine_runs WHERE routine_id=? AND status IN ('scheduled','running','waiting')",
          )
          .get(id)
      )
        throw new TypeError("Drain routine before deletion");
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE routines SET deleted_at=?,updated_at=?,enabled=0,version=version+1 WHERE id=?",
        )
        .run(now, now, id);
      this.db
        .prepare(
          "UPDATE routine_preauth SET revoked_at=? WHERE routine_id=? AND revoked_at IS NULL",
        )
        .run(now, id);
      // Conversation retains routine_id even after soft deletion; UI can display the deleted marker.
      return true;
    });
  }
  pause(id: string, reason: Routine["pausedReason"]) {
    if (!["away_7d", "bot_archived", "trigger_error", null].includes(reason))
      throw new TypeError("Invalid pause reason");
    return (
      this.db
        .prepare(
          "UPDATE routines SET paused_reason=?,updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL AND paused_reason IS NOT ?",
        )
        .run(reason, new Date().toISOString(), IdSchema.parse(id), reason).changes > 0
    );
  }
  resumeAway(ids?: string[], now = new Date().toISOString()) {
    CanonicalTimeSchema.parse(now);
    if (ids && (!ids.length || ids.length > 200)) throw new TypeError("Invalid routine IDs");
    for (const id of ids ?? []) IdSchema.parse(id);
    return transaction(this.db, () => {
      // Move cron watermarks past the paused interval; the scheduler rebuilds next occurrences without catchup.
      const clause = ids ? ` AND id IN (${ids.map(() => "?").join(",")})` : "";
      const affected = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM routines WHERE paused_reason='away_7d' AND deleted_at IS NULL${clause}`,
        )
        .get(...(ids ?? []));
      this.db
        .prepare(
          `UPDATE routine_triggers SET state=json_set(state,'$.lastScheduledAt',?) WHERE kind='cron' AND routine_id IN (SELECT id FROM routines WHERE paused_reason='away_7d' AND deleted_at IS NULL${clause})`,
        )
        .run(now, ...(ids ?? []));
      this.db
        .prepare(
          `UPDATE routines SET paused_reason=NULL,last_scheduled_at=?,updated_at=?,version=version+1 WHERE paused_reason='away_7d' AND deleted_at IS NULL${clause}`,
        )
        .run(now, now, ...(ids ?? []));
      return Number(affected?.n ?? 0);
    });
  }
  watermark(id: string, at: string) {
    CanonicalTimeSchema.parse(at);
    return (
      this.db
        .prepare(
          "UPDATE routines SET last_scheduled_at=? WHERE id=? AND (last_scheduled_at IS NULL OR last_scheduled_at<?)",
        )
        .run(at, IdSchema.parse(id), at).changes > 0
    );
  }
}
