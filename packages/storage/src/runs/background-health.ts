import type { DatabaseSync } from "node:sqlite";
import {
  BACKGROUND_FAILURE_THRESHOLD,
  type BackgroundFailure,
  BackgroundFailureSchema,
  type BackgroundTask,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

const columns =
  "task,subject,reason_code AS reasonCode,streak,first_failed_at AS firstFailedAt,last_failed_at AS lastFailedAt";

// Keep composite inbox IDs unambiguous even if an object ID contains a delimiter.
export const backgroundHealthRowId = "json_array(task,subject,reason_code)";

export class BackgroundTaskHealthRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onVisibleChange?: () => void,
  ) {}

  fail(
    task: BackgroundTask,
    subject: string,
    reasonCode: string,
    at: string = new Date().toISOString(),
  ): void {
    const changed = transaction(this.db, () => {
      // A change of cause ends the old streak for this object only.
      const retired = this.db
        .prepare(
          "DELETE FROM background_task_health WHERE task=? AND subject=? AND reason_code<>? RETURNING streak",
        )
        .all(task, subject, reasonCode);
      const row = this.db
        .prepare(
          `INSERT INTO background_task_health (task,subject,reason_code,streak,first_failed_at,last_failed_at)
           VALUES (?,?,?,1,?,?)
           ON CONFLICT(task,subject,reason_code) DO UPDATE SET
             streak=streak+1, last_failed_at=excluded.last_failed_at
           RETURNING streak`,
        )
        .get(task, subject, reasonCode, at, at);
      return (
        retired.some((row) => Number(row.streak) >= BACKGROUND_FAILURE_THRESHOLD) ||
        Number(row?.streak) >= BACKGROUND_FAILURE_THRESHOLD
      );
    });
    if (changed) this.onVisibleChange?.();
  }

  recover(task: BackgroundTask, subject: string): void {
    const removed = this.db
      .prepare("DELETE FROM background_task_health WHERE task=? AND subject=? RETURNING streak")
      .all(task, subject);
    if (removed.some((row) => Number(row.streak) >= BACKGROUND_FAILURE_THRESHOLD))
      this.onVisibleChange?.();
  }

  /** The person dismissed the card: that streak restarts from zero. */
  dismiss(failure: Pick<BackgroundFailure, "task" | "subject" | "reasonCode">): void {
    const removed = this.db
      .prepare("DELETE FROM background_task_health WHERE task=? AND subject=? AND reason_code=?")
      .run(failure.task, failure.subject, failure.reasonCode);
    if (removed.changes) this.onVisibleChange?.();
  }

  get(id: string): BackgroundFailure | undefined {
    let key: unknown;
    try {
      key = JSON.parse(id);
    } catch {
      // An invalid or obsolete inbox row ID does not refer to a health record.
      return undefined;
    }
    if (!Array.isArray(key) || key.length !== 3) return undefined;
    const [task, subject, reason] = key;
    if (typeof task !== "string" || typeof subject !== "string" || typeof reason !== "string")
      return undefined;
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM background_task_health
         WHERE task=? AND subject=? AND reason_code=? AND streak>=?`,
      )
      .get(task, subject, reason, BACKGROUND_FAILURE_THRESHOLD);
    if (!row) return undefined;
    const failure = BackgroundFailureSchema.parse(row);
    const name = this.subjectName(failure.task, failure.subject);
    return name ? { ...failure, subjectName: name } : failure;
  }

  private subjectName(task: BackgroundTask, subject: string): string | undefined {
    if (!subject) return undefined;
    const row =
      task === "skill_runtime"
        ? this.db
            .prepare(
              `SELECT name FROM skills WHERE id=? AND archived_at IS NULL
               UNION ALL SELECT name FROM group_member_skills WHERE id=? AND archived_at IS NULL
               LIMIT 1`,
            )
            .get(subject, subject)
        : this.db
            .prepare(
              task === "routine_run"
                ? "SELECT name FROM routines WHERE id=? AND deleted_at IS NULL"
                : "SELECT name FROM bots WHERE id=? AND archived_at IS NULL",
            )
            .get(subject);
    const name = row?.name;
    return typeof name === "string" && name ? name : undefined;
  }
}
