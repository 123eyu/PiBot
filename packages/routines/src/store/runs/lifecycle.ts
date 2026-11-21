import type { DatabaseSync } from "node:sqlite";
import {
  CanonicalTimeSchema,
  IdSchema,
  type RoutinePreauthInput,
  RoutinePreauthInputSchema,
  type RoutineResumeVerification,
  RoutineRunSchema,
} from "@pibot/protocol";
import { transaction } from "@pibot/storage";
import { completeOnceAppointments } from "./once-completion.ts";
import { getRoutineRun, requireRoutineRun } from "./record.ts";
import { RoutineRunWaitingRepo, verifyResume } from "./waiting.ts";

const terminal = [
  "done",
  "failed",
  "cancelled",
  "timeout",
  "skipped_overlap",
  "skipped_missed",
] as const;
// SQLite owns slot transitions; trusted adapter assertions never replace real SDK drain.
export class RoutineRunLifecycleRepo {
  constructor(private readonly db: DatabaseSync) {}
  private get(id: string) {
    return getRoutineRun(this.db, id);
  }
  private require(id: string) {
    return requireRoutineRun(this.db, id);
  }
  claim(
    id: string,
    ownerToken: string,
    now = new Date().toISOString(),
    verification?: RoutineResumeVerification,
  ) {
    IdSchema.parse(ownerToken);
    CanonicalTimeSchema.parse(now);
    return transaction(this.db, () => {
      const r = this.get(id);
      if (!r?.runId || r.status !== "scheduled") return undefined;
      if (r.activeMs >= r.maxDurationMin * 60000) return undefined;
      const reserved = this.db
        .prepare(
          "SELECT id FROM routine_runs WHERE bot_id=? AND (status='waiting' OR (status='scheduled' AND wait_checkpoint IS NOT NULL AND decision_consumed_at IS NULL)) ORDER BY created_at,id LIMIT 1",
        )
        .get(r.botId);
      if (reserved && reserved.id !== id) return undefined;
      if (r.waitCheckpoint) {
        if (!verification || !verifyResume(r, verification).drain || r.decisionConsumedAt)
          return undefined;
      }
      if (
        r.status === "scheduled" &&
        r.queueExpiresAt &&
        Date.parse(now) >= Date.parse(r.queueExpiresAt)
      )
        return undefined;
      if (this.db.prepare("SELECT 1 FROM runs WHERE bot_id=? AND status='running'").get(r.botId))
        return undefined;
      if (
        this.db.prepare("SELECT 1 FROM approvals WHERE run_id=? AND status='pending'").get(r.runId)
      )
        return undefined;
      if (
        this.db
          .prepare(
            "UPDATE runs SET status='running',started_at=COALESCE(started_at,?) WHERE id=? AND status IN ('queued','waiting')",
          )
          .run(now, r.runId).changes === 0
      )
        return undefined;
      const waited = r.waitingSince ? Math.max(0, Date.parse(now) - Date.parse(r.waitingSince)) : 0;
      this.db
        .prepare(
          "UPDATE routine_runs SET status='running',owner_token=?,started_at=COALESCE(started_at,?),active_since=?,waiting_ms=waiting_ms+?,waiting_since=NULL,wait_expires_at=NULL,attempt=attempt+1 WHERE id=? AND status IN ('scheduled','waiting')",
        )
        .run(ownerToken, now, now, waited, id);
      return this.require(id);
    });
  }
  beginWaiting(...args: Parameters<RoutineRunWaitingRepo["beginWaiting"]>) {
    return new RoutineRunWaitingRepo(this.db).beginWaiting(...args);
  }
  park(...args: Parameters<RoutineRunWaitingRepo["park"]>) {
    return new RoutineRunWaitingRepo(this.db).park(...args);
  }
  requeueWaiting(...args: Parameters<RoutineRunWaitingRepo["requeueWaiting"]>) {
    return new RoutineRunWaitingRepo(this.db).requeueWaiting(...args);
  }
  consumeDecision(...args: Parameters<RoutineRunWaitingRepo["consumeDecision"]>) {
    return new RoutineRunWaitingRepo(this.db).consumeDecision(...args);
  }
  recordAllowed(id: string, ownerToken: string, operation: RoutinePreauthInput) {
    const op = RoutinePreauthInputSchema.parse(operation);
    return transaction(this.db, () => {
      const r = this.get(id);
      if (r?.reason !== "trial" || !["running", "waiting"].includes(r.status))
        throw new TypeError("Not an active trial");
      // T6 records after reacquiring the slot; a resolved waiting approval alone grants no ownership.
      if (r.status !== "running" || r.ownerToken !== IdSchema.parse(ownerToken))
        throw new TypeError("Trial owner lost");
      const key = JSON.stringify(op),
        list = r.allowedOps;
      if (!list.some((v) => JSON.stringify(v) === key)) list.push(op);
      if (list.length > 200) throw new TypeError("Too many allowed operations");
      this.db
        .prepare("UPDATE routine_runs SET allowed_ops=? WHERE id=? AND owner_token=?")
        .run(JSON.stringify(list), id, ownerToken);
    });
  }
  finish(
    id: string,
    status: "done" | "failed" | "cancelled" | "timeout",
    options: {
      ownerToken?: string;
      errorCode?: string;
      summary?: string;
      now?: string;
      activeElapsedMs?: number;
    } = {},
  ) {
    if (
      options.activeElapsedMs !== undefined &&
      (!Number.isSafeInteger(options.activeElapsedMs) || options.activeElapsedMs < 0)
    )
      throw new TypeError("Invalid active elapsed time");
    const now = options.now ?? new Date().toISOString();
    CanonicalTimeSchema.parse(now);
    if (!["done", "failed", "cancelled", "timeout"].includes(status))
      throw new TypeError("Invalid terminal state");
    return transaction(this.db, () => {
      const r = this.get(id);
      if (!r || terminal.includes(r.status as (typeof terminal)[number])) return false;
      if (status === "done" && (r.status !== "running" || !r.runId))
        throw new TypeError("Completion requires an owned execution");
      // A parked run has no owner; a retired execution token must not settle it in that gap.
      if (
        (options.ownerToken !== undefined || r.ownerToken !== null) &&
        r.ownerToken !== options.ownerToken
      )
        throw new TypeError("Run owner lost");
      const active = r.activeSince
          ? (options.activeElapsedMs ?? Math.max(0, Date.parse(now) - Date.parse(r.activeSince)))
          : 0,
        waited = r.waitingSince ? Math.max(0, Date.parse(now) - Date.parse(r.waitingSince)) : 0;
      const checked = RoutineRunSchema.parse({
        ...r,
        status,
        errorCode: options.errorCode ?? null,
        summary: options.summary ?? null,
        ownerToken: null,
        activeSince: null,
      });
      this.db
        .prepare(
          "UPDATE routine_runs SET status=?,finished_at=?,error_code=?,summary=?,active_ms=active_ms+?,waiting_ms=waiting_ms+?,active_since=NULL,waiting_since=NULL,wait_expires_at=NULL,owner_token=NULL WHERE id=?",
        )
        .run(status, now, checked.errorCode, checked.summary, active, waited, id);
      if (r.runId)
        this.db
          .prepare(
            "UPDATE approvals SET status=?,resolved_at=?,remembered=0 WHERE run_id=? AND status='pending'",
          )
          .run(status === "timeout" ? "expired" : "cancelled", now, r.runId);
      if (r.runId)
        this.db
          .prepare(
            "UPDATE runs SET status=?,stop_reason=?,error_code=?,finished_at=? WHERE id=? AND status IN ('queued','running','waiting')",
          )
          .run(
            status === "done" ? "done" : status === "cancelled" ? "aborted" : "error",
            status,
            checked.errorCode,
            now,
            r.runId,
          );
      completeOnceAppointments(this.db, now, id);
      return true;
    });
  }
}
