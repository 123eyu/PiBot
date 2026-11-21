import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Run } from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { RunsRepo } from "./runs.ts";

export function backgroundCompletionTrigger(jobIds: readonly string[]) {
  if (jobIds.length === 1) return `background_finished:${jobIds[0]}`;
  return `background_finished:batch:${createHash("sha256")
    .update([...jobIds].sort().join("\n"))
    .digest("hex")}`;
}

/** Read source intent from durable facts, never from command output or model text. */
export class BackgroundContinuationsRepo {
  constructor(private readonly db: DatabaseSync) {}

  trigger(jobIds: readonly string[]) {
    return backgroundCompletionTrigger(jobIds);
  }

  resumed(jobId: string) {
    const row = this.db
      .prepare("SELECT run_id AS id FROM background_completion_runs WHERE job_id=?")
      .get(jobId);
    const runs = new RunsRepo(this.db);
    return row ? runs.get(String(row.id)) : runs.trigger(`background_finished:${jobId}`);
  }

  bind(jobIds: string[], runId: string) {
    const insert = this.db.prepare(
      "INSERT INTO background_completion_runs(job_id,run_id) VALUES (?,?)",
    );
    for (const id of jobIds) insert.run(id, runId);
  }

  /** start() stamps startedAt before any SDK work; a null session alone is not a dispatch proof. */
  undelivered(jobId: string) {
    const run = this.resumed(jobId);
    return run?.automatic &&
      run.triggerKey?.startsWith("background_finished:") &&
      ["queued", "aborted", "error"].includes(run.status) &&
      run.startedAt === null &&
      run.sessionFile === null &&
      this.superseded(run)
      ? run
      : undefined;
  }

  rebindUndelivered(jobId: string, previousRunId: string, runId: string) {
    return transaction(this.db, () => {
      const previous = this.undelivered(jobId);
      const next = new RunsRepo(this.db).get(runId);
      if (
        previous?.id !== previousRunId ||
        !next ||
        next.automatic ||
        next.status !== "running" ||
        next.botId !== previous.botId ||
        next.conversationId !== previous.conversationId ||
        next.groupId !== previous.groupId
      )
        return false;
      this.db
        .prepare("DELETE FROM background_completion_runs WHERE job_id=? AND run_id=?")
        .run(jobId, previousRunId);
      this.bind([jobId], runId);
      return true;
    });
  }

  jobs(runId: string): string[] {
    return this.db
      .prepare(
        "SELECT job_id AS id FROM background_completion_runs WHERE run_id=? ORDER BY job_id LIMIT 32",
      )
      .all(runId)
      .map((row) => String(row.id));
  }

  latestUser(conversationId: string) {
    const row = this.db
      .prepare(
        "SELECT id FROM messages WHERE conversation_id=? AND role='user' AND COALESCE(json_extract(usage,'$.systemEvent'),0)=0 ORDER BY rowid DESC LIMIT 1",
      )
      .get(conversationId);
    return row ? String(row.id) : "";
  }

  superseded(run: Run) {
    return !!this.db
      .prepare(`SELECT 1 FROM messages next
      JOIN messages source ON source.id=?
      WHERE next.conversation_id=source.conversation_id AND next.rowid>source.rowid
      AND next.role='user' AND COALESCE(json_extract(next.usage,'$.systemEvent'),0)=0 LIMIT 1`)
      .get(run.userMessageId ?? run.messageId);
  }

  declined(runId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM approvals WHERE run_id=? AND status='denied' LIMIT 1")
      .get(runId);
  }
}
