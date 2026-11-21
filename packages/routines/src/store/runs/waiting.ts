import type { DatabaseSync } from "node:sqlite";
import {
  CanonicalTimeSchema,
  IdSchema,
  RoutineDrainSchema,
  type RoutineResumeVerification,
  RoutineResumeVerificationSchema,
  type RoutineRun,
  RoutineTimingDefaults,
  RoutineTimingSchema,
  type RoutineWaitCheckpoint,
  RoutineWaitCheckpointSchema,
} from "@pibot/protocol";
import { transaction } from "@pibot/storage";
import { requireRoutineRun } from "./record.ts";

export function verifyResume(r: RoutineRun, input: RoutineResumeVerification) {
  const v = RoutineResumeVerificationSchema.parse(input),
    c = r.waitCheckpoint;
  if (
    !c ||
    c.botId !== r.botId ||
    c.routineRunId !== r.id ||
    c.runId !== r.runId ||
    c.conversationId !== r.conversationId ||
    c.sessionFile !== r.sessionFile ||
    Object.entries(v).some(
      ([k, value]) =>
        k !== "managedSessionVerified" &&
        JSON.stringify(value) !== JSON.stringify(c[k as keyof typeof c]),
    )
  )
    throw new TypeError("Resume identity or authorization snapshot changed");
  return c;
}
// Held gates retain the actual running slot. Only a drained adapter assertion can park it.
export class RoutineRunWaitingRepo {
  constructor(private readonly db: DatabaseSync) {}
  beginWaiting(
    id: string,
    owner: string,
    input: RoutineWaitCheckpoint,
    activeElapsedMs: number,
    now = new Date().toISOString(),
  ) {
    const c = RoutineWaitCheckpointSchema.parse(input);
    IdSchema.parse(owner);
    CanonicalTimeSchema.parse(now);
    if (c.drain !== null || !Number.isSafeInteger(activeElapsedMs) || activeElapsedMs < 0)
      throw new TypeError("Invalid held gate checkpoint");
    return transaction(this.db, () => {
      const r = requireRoutineRun(this.db, id);
      if (
        r.status !== "running" ||
        r.ownerToken !== owner ||
        !r.runId ||
        (r.waitCheckpoint && !r.decisionConsumedAt)
      )
        return undefined;
      if (
        c.routineRunId !== r.id ||
        c.runId !== r.runId ||
        c.botId !== r.botId ||
        c.conversationId !== r.conversationId ||
        c.attempt !== r.attempt
      )
        throw new TypeError("Checkpoint execution identity changed");
      const approval = this.db
        .prepare(
          "SELECT * FROM approvals WHERE id=? AND routine_run_id=? AND run_id=? AND bot_id=? AND message_id=? AND status='pending'",
        )
        .get(c.approvalId, id, r.runId, r.botId, c.messageId);
      const execution = this.db
        .prepare("SELECT message_id,status FROM runs WHERE id=?")
        .get(r.runId);
      if (
        !approval ||
        execution?.status !== "running" ||
        execution.message_id !== c.messageId ||
        String(approval.expires_at) <= now
      )
        throw new TypeError("Pending gate approval changed");
      this.db.prepare("UPDATE runs SET session_file=? WHERE id=?").run(c.sessionFile, r.runId);
      this.db
        .prepare(
          "UPDATE routine_runs SET status='waiting',active_since=NULL,active_ms=active_ms+?,waiting_since=?,wait_expires_at=?,session_file=?,wait_checkpoint=?,decision_consumed_at=NULL WHERE id=? AND owner_token=?",
        )
        .run(
          activeElapsedMs,
          now,
          String(approval.expires_at),
          c.sessionFile,
          JSON.stringify(c),
          id,
          owner,
        );
      return requireRoutineRun(this.db, id);
    });
  }
  park(id: string, owner: string, drain: unknown, now = new Date().toISOString()) {
    const proof = RoutineDrainSchema.parse(drain);
    IdSchema.parse(owner);
    CanonicalTimeSchema.parse(now);
    if (proof.at > now) throw new TypeError("Future drain assertion");
    return transaction(this.db, () => {
      const r = requireRoutineRun(this.db, id),
        c = r.waitCheckpoint;
      if (
        r.status !== "waiting" ||
        r.ownerToken !== owner ||
        !c ||
        c.drain ||
        c.attempt !== r.attempt ||
        proof.at < (r.waitingSince ?? now) ||
        r.decisionConsumedAt
      )
        return undefined;
      if (
        this.db
          .prepare("UPDATE runs SET status='waiting' WHERE id=? AND status='running'")
          .run(r.runId).changes !== 1
      )
        throw new TypeError("Execution slot lost before drain commit");
      this.db
        .prepare(
          "UPDATE routine_runs SET owner_token=NULL,wait_checkpoint=? WHERE id=? AND owner_token=?",
        )
        .run(JSON.stringify({ ...c, drain: proof }), id, owner);
      return requireRoutineRun(this.db, id);
    });
  }
  requeueWaiting(
    id: string,
    verification: RoutineResumeVerification,
    queueWaitMs = RoutineTimingDefaults.queueWaitMs,
    now = new Date().toISOString(),
  ) {
    CanonicalTimeSchema.parse(now);
    RoutineTimingSchema.shape.queueWaitMs.parse(queueWaitMs);
    return transaction(this.db, () => {
      const r = requireRoutineRun(this.db, id),
        c = verifyResume(r, verification);
      if (r.status !== "waiting" || r.ownerToken || !c.drain || r.decisionConsumedAt)
        return undefined;
      const a = this.db
        .prepare("SELECT status FROM approvals WHERE id=? AND routine_run_id=? AND run_id=?")
        .get(c.approvalId, id, r.runId);
      if (!a || !["allowed", "denied", "expired"].includes(String(a.status))) return undefined;
      if (
        this.db
          .prepare("UPDATE runs SET status='queued' WHERE id=? AND status='waiting'")
          .run(r.runId).changes !== 1
      )
        throw new TypeError("Parked execution changed");
      this.db
        .prepare(
          "UPDATE routine_runs SET status='scheduled',queued_at=?,queue_expires_at=?,waiting_ms=waiting_ms+?,waiting_since=NULL,wait_expires_at=NULL WHERE id=?",
        )
        .run(
          now,
          new Date(Date.parse(now) + queueWaitMs).toISOString(),
          Math.max(0, Date.parse(now) - Date.parse(r.waitingSince ?? now)),
          id,
        );
      return requireRoutineRun(this.db, id);
    });
  }
  // Both branches consume the original decision once. Parked reentry still needs a new tool_call.
  consumeDecision(
    id: string,
    owner: string,
    verification: RoutineResumeVerification,
    now = new Date().toISOString(),
  ) {
    IdSchema.parse(owner);
    CanonicalTimeSchema.parse(now);
    return transaction(this.db, () => {
      const r = requireRoutineRun(this.db, id),
        c = verifyResume(r, verification);
      const branch = c.drain ? "parked_reentry" : "held_gate";
      if (
        r.ownerToken !== owner ||
        r.decisionConsumedAt ||
        (c.drain
          ? r.status !== "running" || r.attempt <= c.attempt
          : r.status !== "waiting" || r.attempt !== c.attempt)
      )
        return undefined;
      const a = this.db
        .prepare("SELECT status FROM approvals WHERE id=? AND routine_run_id=? AND run_id=?")
        .get(c.approvalId, id, r.runId);
      if (!a || !["allowed", "denied", "expired"].includes(String(a.status))) return undefined;
      const waited = r.waitingSince ? Math.max(0, Date.parse(now) - Date.parse(r.waitingSince)) : 0;
      this.db
        .prepare(
          "UPDATE routine_runs SET status='running',active_since=COALESCE(active_since,?),waiting_ms=waiting_ms+?,waiting_since=NULL,wait_expires_at=NULL,decision_consumed_at=? WHERE id=? AND decision_consumed_at IS NULL",
        )
        .run(now, waited, now, id);
      return {
        branch,
        status: a.status as "allowed" | "denied" | "expired",
        approvalId: c.approvalId,
        operationHash: c.operationHash,
      };
    });
  }
}
