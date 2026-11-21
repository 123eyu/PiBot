import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/database.ts";

export interface ApprovalPause {
  approvalId: string;
  callHash: string;
  factsHash: string;
  pausedAt: string;
  resumedRunId: string | null;
  choice: unknown;
}

/** Digests bind a human answer to one re-evaluated operation, never to arbitrary session calls. */
export class ApprovalPausesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): ApprovalPause | undefined {
    const row = this.db
      .prepare(`SELECT approval_id AS approvalId,call_hash AS callHash,
      facts_hash AS factsHash,paused_at AS pausedAt,resumed_run_id AS resumedRunId,choice_json AS choice
      FROM chat_approval_pauses WHERE approval_id=?`)
      .get(id) as unknown as ApprovalPause | undefined;
    return row
      ? { ...row, choice: typeof row.choice === "string" ? JSON.parse(row.choice) : undefined }
      : undefined;
  }
  pause(id: string, callHash: string, factsHash: string) {
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO chat_approval_pauses
        (approval_id,call_hash,facts_hash,paused_at) VALUES (?,?,?,?)`)
        .run(id, callHash, factsHash, new Date().toISOString());
      this.db.prepare("UPDATE approvals SET timeout_paused=1 WHERE id=?").run(id);
    });
  }

  choice(id: string, value: unknown) {
    const json = JSON.stringify(value);
    if (json.length > 16_384) throw new TypeError("approval_choice_too_large");
    this.db
      .prepare(`UPDATE chat_approval_pauses SET choice_json=? WHERE approval_id=?
      AND resumed_run_id IS NULL AND EXISTS(SELECT 1 FROM approvals a WHERE a.id=approval_id AND a.status='pending')`)
      .run(json, id);
  }
  clearChoice(id: string, value: unknown) {
    this.db
      .prepare(`UPDATE chat_approval_pauses SET choice_json=NULL
      WHERE approval_id=? AND choice_json=? AND resumed_run_id IS NULL`)
      .run(id, JSON.stringify(value));
  }
  takeChoice(runId: string, callId: string): unknown {
    const row = this.db
      .prepare(`SELECT approval_id AS id,choice_json AS choice FROM chat_approval_pauses
      WHERE resumed_run_id=? AND resumed_call_id=? AND consumed=1 AND choice_json IS NOT NULL`)
      .get(runId, callId);
    if (!row) return;
    this.db
      .prepare("UPDATE chat_approval_pauses SET choice_json=NULL WHERE approval_id=?")
      .run(String(row.id));
    return JSON.parse(String(row.choice));
  }
  resumed(id: string, runId: string) {
    const changed = this.db
      .prepare(`UPDATE chat_approval_pauses SET resumed_run_id=?
      WHERE approval_id=? AND resumed_run_id IS NULL`)
      .run(runId, id).changes;
    if (!changed) throw new Error("approval_resume_changed");
  }
  consume(
    runId: string,
    callHash: string,
    factsHash?: string,
    callId?: string,
  ): "allowed" | "denied" | undefined {
    const row = this.db
      .prepare(`SELECT p.approval_id AS id,a.status FROM chat_approval_pauses p
      JOIN approvals a ON a.id=p.approval_id WHERE p.resumed_run_id=? AND p.consumed=0
      AND a.status IN ('allowed','denied') AND p.call_hash=?
      AND (a.status='denied' OR p.facts_hash=?) LIMIT 1`)
      .get(runId, callHash, factsHash ?? "");
    if (!row) return;
    this.db
      .prepare(
        "UPDATE chat_approval_pauses SET consumed=1,resumed_call_id=? WHERE approval_id=? AND consumed=0",
      )
      .run(callId ?? null, String(row.id));
    return row.status === "allowed" ? "allowed" : "denied";
  }
}
