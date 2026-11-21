import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CanonicalTimeSchema,
  IdSchema,
  type Page,
  PageSchema,
  RoutineDraftSchema,
  type RoutineHistoryQuery,
  type RoutineRun,
  RoutineRunSchema,
  type RoutineRunStatus,
  RoutineTimingDefaults,
  RoutineTimingSchema,
  RoutineTriggerInputSchema,
} from "@pibot/protocol";
import { readPage, transaction } from "@pibot/storage";
import { routineHistory, routineHistoryCount } from "./history.ts";
import { RoutineRunLifecycleRepo } from "./lifecycle.ts";
import { RoutineRunMissedRepo } from "./missed.ts";
import { completeOnceAppointments } from "./once-completion.ts";
import { routineRunColumns as columns, parseRoutineRun as parse } from "./record.ts";
import { recoverRoutineRuns } from "./recovery.ts";
export type EnqueueRoutineRun = Pick<
  RoutineRun,
  "routineId" | "botId" | "triggerId" | "reason" | "scheduledFor" | "dedupeKey"
> & {
  trialDraft?: unknown;
  status?: "scheduled" | "missed" | "skipped_missed";
  /** The failed run this one resumes; it inherits that run's occurrence. */
  resumeOf?: string;
};
const terminal = [
  "done",
  "failed",
  "cancelled",
  "timeout",
  "skipped_overlap",
  "skipped_missed",
] as const;
export class RoutineRunsRepo {
  constructor(private readonly db: DatabaseSync) {}
  require(id: string) {
    const value = this.get(id);
    if (!value) throw new TypeError("Missing persisted record");
    return value;
  }
  /** The live run asks for the user's attention; the first reason stands (a run flags once). */
  flagAttention(id: string, reason: string) {
    return (
      this.db
        .prepare(
          "UPDATE routine_runs SET attention_reason=? WHERE id=? AND status IN ('running','waiting') AND attention_reason IS NULL",
        )
        .run(reason, IdSchema.parse(id)).changes > 0
    );
  }
  get(id: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM routine_runs WHERE id=?`)
      .get(IdSchema.parse(id));
    return row ? parse(row) : undefined;
  }
  byExecution(runId: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM routine_runs WHERE run_id=?`)
      .get(IdSchema.parse(runId));
    return row ? parse(row) : undefined;
  }
  list(routineId: string, page: Page = {}) {
    return readPage(this.db, "routine_runs", columns, "created_at", page, [
      ["routine_id", IdSchema.parse(routineId)],
    ]).map(parse);
  }
  history(query: RoutineHistoryQuery = {}) {
    return routineHistory(this.db, query);
  }
  historyCount(query: Parameters<typeof routineHistoryCount>[1]) {
    return routineHistoryCount(this.db, query);
  }
  page(status: RoutineRunStatus, page: Page = {}, routineId?: string) {
    RoutineRunSchema.shape.status.parse(status);
    const scope: [string, string][] = routineId ? [["routine_id", IdSchema.parse(routineId)]] : [];
    // Processing settles each page; the last cursor must survive its status transition.
    return readPage(
      this.db,
      "routine_runs",
      columns,
      "created_at",
      page,
      [["status", status], ...scope],
      scope,
    ).map(parse);
  }
  oldestWaitingAt() {
    const row = this.db
      .prepare(
        "SELECT MIN(COALESCE(waiting_since,created_at)) AS at FROM routine_runs WHERE status='waiting'",
      )
      .get();
    return row?.at == null ? null : CanonicalTimeSchema.parse(row.at);
  }
  timeline(from: string, to: string, page: Page = {}) {
    CanonicalTimeSchema.parse(from);
    CanonicalTimeSchema.parse(to);
    if (from >= to) throw new TypeError("Invalid time interval");
    const { before, limit = 50 } = PageSchema.parse(page),
      cursor = before ? this.get(before) : undefined;
    if (before && (!cursor || cursor.scheduledFor < from || cursor.scheduledFor >= to)) return [];
    return this.db
      .prepare(
        `SELECT ${columns} FROM routine_runs WHERE scheduled_for>=? AND scheduled_for<? AND (? IS NULL OR scheduled_for<? OR (scheduled_for=? AND id<?)) ORDER BY scheduled_for DESC,id DESC LIMIT ?`,
      )
      .all(
        from,
        to,
        before ?? null,
        cursor?.scheduledFor ?? null,
        cursor?.scheduledFor ?? null,
        before ?? null,
        limit,
      )
      .map(parse);
  }
  enqueue(input: EnqueueRoutineRun, queueWaitMs = RoutineTimingDefaults.queueWaitMs) {
    RoutineTimingSchema.shape.queueWaitMs.parse(queueWaitMs);
    return transaction(this.db, () => {
      const now = new Date().toISOString();
      const value = RoutineRunSchema.parse({
        ...input,
        id: randomUUID(),
        status: input.status ?? "scheduled",
        queuedAt: input.status === "missed" || input.status === "skipped_missed" ? null : now,
        queueExpiresAt:
          input.status === "missed" || input.status === "skipped_missed"
            ? null
            : new Date(Date.parse(now) + queueWaitMs).toISOString(),
        maxDurationMin: input.routineId
          ? this.db.prepare("SELECT max_duration_min FROM routines WHERE id=?").get(input.routineId)
              ?.max_duration_min
          : RoutineDraftSchema.parse(input.trialDraft).maxDurationMin,
        startedAt: null,
        finishedAt: null,
        runId: null,
        conversationId: null,
        triggerMessageId: null,
        errorCode: null,
        summary: null,
        allowedOps: [],
        trialDraft: input.trialDraft == null ? null : RoutineDraftSchema.parse(input.trialDraft),
        activeMs: 0,
        waitingMs: 0,
        activeSince: null,
        waitingSince: null,
        waitExpiresAt: null,
        ownerToken: null,
        sessionFile: null,
        attempt: 0,
        waitCheckpoint: null,
        decisionConsumedAt: null,
        createdAt: now,
      });
      const resumed = input.resumeOf ? this.get(input.resumeOf) : undefined;
      if (input.resumeOf && (!resumed || resumed.routineId !== value.routineId))
        throw new TypeError("Wrong resumed run");
      const existing = this.db
        .prepare(`SELECT ${columns} FROM routine_runs WHERE dedupe_key=?`)
        .get(value.dedupeKey);
      if (existing) {
        const old = parse(existing);
        if (
          old.routineId !== value.routineId ||
          old.botId !== value.botId ||
          (old.reason !== value.reason &&
            !(old.reason === "catchup" && (value.reason === "cron" || value.reason === "once"))) ||
          old.triggerId !== value.triggerId ||
          JSON.stringify(old.trialDraft) !== JSON.stringify(value.trialDraft) ||
          old.scheduledFor !== value.scheduledFor
        )
          throw new TypeError("Run dedupe identity conflict");
        return old;
      }
      if (
        !this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(value.botId)
      )
        throw new TypeError("Unknown or archived Bot");
      if (value.routineId) {
        const routine = this.db
          .prepare("SELECT bot_id,deleted_at FROM routines WHERE id=?")
          .get(value.routineId);
        if (!routine || routine.bot_id !== value.botId || routine.deleted_at)
          throw new TypeError("Wrong routine Bot");
        if (
          value.triggerId &&
          !this.db
            .prepare(
              "SELECT 1 FROM routine_triggers WHERE id=? AND routine_id=? AND deleted_at IS NULL",
            )
            .get(value.triggerId, value.routineId)
        )
          throw new TypeError("Wrong trigger");
        if (value.reason === "once" && !value.triggerId)
          throw new TypeError("Missing once appointment");
        if (value.triggerId) {
          const row = this.db
            .prepare("SELECT config FROM routine_triggers WHERE id=?")
            .get(value.triggerId);
          const trigger = RoutineTriggerInputSchema.parse(JSON.parse(String(row?.config)));
          if (
            trigger.kind === "once" &&
            (!["once", "catchup"].includes(value.reason) ||
              value.dedupeKey !== `once:${value.triggerId}` ||
              value.scheduledFor !== trigger.at)
          )
            throw new TypeError("Wrong once appointment identity");
          if (value.reason === "once" && trigger.kind !== "once")
            throw new TypeError("Wrong once trigger");
        }
        if (
          value.status === "scheduled" &&
          this.db
            .prepare(
              "SELECT 1 FROM routine_runs WHERE routine_id=? AND status IN ('scheduled','running','waiting')",
            )
            .get(value.routineId)
        )
          value.status = "skipped_overlap";
      } else if (value.triggerId || value.trialDraft?.botId !== value.botId)
        throw new TypeError("Invalid trial identity");
      const ended = terminal.includes(value.status as (typeof terminal)[number]);
      this.db
        .prepare(
          "INSERT INTO routine_runs(id,routine_id,bot_id,trigger_id,reason,scheduled_for,status,trial_draft,dedupe_key,created_at,finished_at,queued_at,queue_expires_at,max_duration_min,resume_of,occurrence_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          value.id,
          value.routineId,
          value.botId,
          value.triggerId,
          value.reason,
          value.scheduledFor,
          value.status,
          value.trialDraft ? JSON.stringify(value.trialDraft) : null,
          value.dedupeKey,
          now,
          ended ? now : null,
          ended ? null : value.queuedAt,
          ended ? null : value.queueExpiresAt,
          value.maxDurationMin,
          resumed?.id ?? null,
          resumed ? (resumed.occurrenceId ?? resumed.id) : null,
        );
      if (ended) completeOnceAppointments(this.db, now, value.id);
      return this.require(value.id);
    });
  }
  // A parked gate reserves its Bot even after releasing the SDK slot; an approved requeue keeps it.
  reservation(botId: string, conversationId?: string) {
    const row = this.db
      .prepare(
        "SELECT id FROM routine_runs WHERE bot_id=? AND (? IS NULL OR conversation_id=?) AND (status='waiting' OR (status='scheduled' AND wait_checkpoint IS NOT NULL AND decision_consumed_at IS NULL)) ORDER BY created_at,id LIMIT 1",
      )
      .get(IdSchema.parse(botId), conversationId ?? null, conversationId ?? null);
    return row ? this.require(String(row.id)) : undefined;
  }
  bindTrigger(id: string, messageId: string) {
    return transaction(this.db, () => {
      const r = this.require(id);
      const message = this.db
        .prepare("SELECT conversation_id,routine_trigger,role FROM messages WHERE id=?")
        .get(IdSchema.parse(messageId));
      const c =
        message &&
        this.db
          .prepare("SELECT bot_id,routine_id FROM conversations WHERE id=?")
          .get(String(message.conversation_id));
      if (
        !c ||
        c.bot_id !== r.botId ||
        (r.routineId && c.routine_id !== r.routineId) ||
        message?.role !== "user" ||
        JSON.parse(String(message.routine_trigger)).routineRunId !== id ||
        !(
          ["scheduled", "missed"].includes(r.status) ||
          (["skipped_missed", "skipped_overlap"].includes(r.status) &&
            r.triggerId &&
            this.db
              .prepare("SELECT 1 FROM routine_triggers WHERE id=? AND kind='once'")
              .get(r.triggerId))
        )
      )
        throw new TypeError("Wrong trigger identity");
      if (r.triggerMessageId && r.triggerMessageId !== messageId)
        throw new TypeError("Trigger already bound");
      this.db
        .prepare(
          "UPDATE routine_runs SET conversation_id=?,trigger_message_id=? WHERE id=? AND trigger_message_id IS NULL",
        )
        .run(String(message.conversation_id), messageId, id);
      return this.require(id);
    });
  }
  bindExecution(id: string, runId: string, triggerMessageId: string) {
    return transaction(this.db, () => {
      const r = this.get(id),
        run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(IdSchema.parse(runId));
      if (
        r?.status !== "scheduled" ||
        !run ||
        run.bot_id !== r.botId ||
        run.kind !== "routine" ||
        run.status !== "queued"
      )
        throw new TypeError("Wrong execution identity");
      if (r.runId) {
        if (r.runId !== runId) throw new TypeError("Execution already bound");
        return r;
      }
      const message = this.db
        .prepare("SELECT conversation_id FROM messages WHERE id=?")
        .get(IdSchema.parse(triggerMessageId));
      const c = this.db
        .prepare("SELECT bot_id,routine_id FROM conversations WHERE id=?")
        .get(String(run.conversation_id));
      if (
        !c ||
        c.bot_id !== r.botId ||
        (r.routineId && c.routine_id !== r.routineId) ||
        (r.triggerMessageId !== null && r.triggerMessageId !== triggerMessageId) ||
        message?.conversation_id !== run.conversation_id
      )
        throw new TypeError("Wrong run conversation");
      this.db
        .prepare(
          "UPDATE routine_runs SET run_id=?,conversation_id=?,trigger_message_id=? WHERE id=? AND run_id IS NULL",
        )
        .run(runId, String(run.conversation_id), triggerMessageId, id);
      return this.require(id);
    });
  }
  claim(...args: Parameters<RoutineRunLifecycleRepo["claim"]>) {
    return new RoutineRunLifecycleRepo(this.db).claim(...args);
  }
  beginWaiting(...args: Parameters<RoutineRunLifecycleRepo["beginWaiting"]>) {
    return new RoutineRunLifecycleRepo(this.db).beginWaiting(...args);
  }
  park(...args: Parameters<RoutineRunLifecycleRepo["park"]>) {
    return new RoutineRunLifecycleRepo(this.db).park(...args);
  }
  requeueWaiting(...args: Parameters<RoutineRunLifecycleRepo["requeueWaiting"]>) {
    return new RoutineRunLifecycleRepo(this.db).requeueWaiting(...args);
  }
  consumeDecision(...args: Parameters<RoutineRunLifecycleRepo["consumeDecision"]>) {
    return new RoutineRunLifecycleRepo(this.db).consumeDecision(...args);
  }
  recordAllowed(...args: Parameters<RoutineRunLifecycleRepo["recordAllowed"]>) {
    return new RoutineRunLifecycleRepo(this.db).recordAllowed(...args);
  }
  finish(...args: Parameters<RoutineRunLifecycleRepo["finish"]>) {
    return new RoutineRunLifecycleRepo(this.db).finish(...args);
  }
  resolveMissed(...args: Parameters<RoutineRunMissedRepo["resolve"]>) {
    return new RoutineRunMissedRepo(this.db).resolve(...args);
  }
  /** The period a run writes, fixed once when it is first prepared. */
  setPeriod(id: string, periodKey: string) {
    if (!periodKey || periodKey.length > 40) throw new TypeError("Invalid period key");
    this.db
      .prepare("UPDATE routine_runs SET period_key=? WHERE id=? AND period_key IS NULL")
      .run(periodKey, IdSchema.parse(id));
    return this.require(id);
  }
  /** Every attempt of one occurrence, oldest first (bounded: a resume chain is user-driven). */
  attempts(occurrenceId: string) {
    return this.db
      .prepare(
        `SELECT ${columns} FROM routine_runs WHERE id=? OR occurrence_id=? ORDER BY created_at,id LIMIT 50`,
      )
      .all(IdSchema.parse(occurrenceId), occurrenceId)
      .map(parse);
  }
  /** The latest finished run of an earlier period, the one the next period compares with. */
  previousPeriod(routineId: string, periodKey: string, before: string) {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM routine_runs WHERE routine_id=? AND status='done' AND period_key IS NOT NULL AND period_key<>? AND scheduled_for<=? ORDER BY scheduled_for DESC,id DESC LIMIT 1`,
      )
      .get(IdSchema.parse(routineId), periodKey, CanonicalTimeSchema.parse(before));
    return row ? parse(row) : undefined;
  }
  hasActive(routineId: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM routine_runs WHERE routine_id=? AND status IN ('scheduled','running','waiting')",
      )
      .get(IdSchema.parse(routineId));
  }
  /** The latest finished run of a routine other than this one (what "carry last result" reads). */
  lastDone(routineId: string, exceptId: string) {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM routine_runs WHERE routine_id=? AND status='done' AND id<>? ORDER BY finished_at DESC,id DESC LIMIT 1`,
      )
      .get(IdSchema.parse(routineId), IdSchema.parse(exceptId));
    return row ? parse(row) : undefined;
  }
  /** Runs of one period of a routine (attempts and repeat runs), newest first, bounded. */
  inPeriod(routineId: string, periodKey: string) {
    return this.db
      .prepare(
        `SELECT ${columns} FROM routine_runs WHERE routine_id=? AND period_key=? ORDER BY scheduled_for DESC,id DESC LIMIT 20`,
      )
      .all(IdSchema.parse(routineId), periodKey)
      .map(parse);
  }
  dismissNotice(id: string) {
    return (
      this.db
        .prepare(
          "UPDATE routine_runs SET inbox_dismissed_at=? WHERE id=? AND status='skipped_missed' AND inbox_dismissed_at IS NULL",
        )
        .run(new Date().toISOString(), IdSchema.parse(id)).changes > 0
    );
  }
  recover(now = new Date().toISOString()) {
    return recoverRoutineRuns(this.db, now);
  }
}
