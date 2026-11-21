import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type Page,
  type Recording,
  RecordingSchema,
  type RecordingStatus,
  TEACH_MAX_STEPS,
  type TeachStep,
  TeachStepSchema,
} from "@pibot/skills-contract/full";
import { readPage, transaction } from "@pibot/storage";

const columns = `id,bot_id AS botId,started_at AS startedAt,ended_at AS endedAt,steps,status`;
function parse(row: Record<string, unknown>): Recording {
  return RecordingSchema.parse({ ...row, steps: JSON.parse(String(row.steps)) });
}
/** Allowed transitions of the three-step teach flow; anything else is a stale or forged call. */
const NEXT: Record<RecordingStatus, readonly RecordingStatus[]> = {
  recording: ["review", "failed", "discarded"],
  review: ["drafted", "discarded", "failed"],
  drafted: ["drafted", "saved", "discarded"],
  saved: [],
  discarded: [],
  failed: ["discarded"],
};

export class RecordingsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** One active recording per Bot; the partial unique index backs this against races. */
  start(botId: string): Recording {
    const recording = RecordingSchema.parse({
      id: randomUUID(),
      botId,
      status: "recording",
      startedAt: new Date().toISOString(),
      endedAt: null,
      steps: [],
    });
    return transaction(this.db, () => {
      if (
        this.db
          .prepare("SELECT 1 FROM recordings WHERE bot_id=? AND status='recording'")
          .get(recording.botId)
      )
        throw new TypeError("Recording already active");
      this.db
        .prepare(
          "INSERT INTO recordings(id,bot_id,started_at,ended_at,steps,status) VALUES (?,?,?,NULL,'[]','recording')",
        )
        .run(recording.id, recording.botId, recording.startedAt);
      return recording;
    });
  }

  get(id: string): Recording | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM recordings WHERE id=?`)
      .get(IdSchema.parse(id));
    return row ? parse(row) : undefined;
  }

  active(botId: string): Recording | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM recordings WHERE bot_id=? AND status='recording'`)
      .get(IdSchema.parse(botId));
    return row ? parse(row) : undefined;
  }

  /** Recordings a teach page could still pick up, newest first; normally at most one. */
  unfinished(botId: string, limit = 20): Recording[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM recordings WHERE bot_id=? AND status IN ('recording','review','drafted') ORDER BY started_at DESC LIMIT ?`,
      )
      .all(IdSchema.parse(botId), limit)
      .map((row) => parse(row as Record<string, unknown>));
  }

  list(botId: string, page: Page = {}): Recording[] {
    const scope: [string, string][] = [["bot_id", IdSchema.parse(botId)]];
    return readPage(this.db, "recordings", columns, "started_at", page, scope).map(parse);
  }

  /**
   * Replaces the step list while recording (the recorder batches steps, so this is not per
   * event). Indexes are renumbered here so callers cannot leave gaps after merging steps.
   */
  saveSteps(id: string, steps: Omit<TeachStep, "index">[]): Recording {
    if (steps.length > TEACH_MAX_STEPS) throw new TypeError("Too many steps");
    const value = steps.map((step, index) => TeachStepSchema.parse({ ...step, index }));
    return transaction(this.db, () => {
      const changed = this.db
        .prepare("UPDATE recordings SET steps=? WHERE id=? AND status='recording'")
        .run(JSON.stringify(value), IdSchema.parse(id)).changes;
      if (!changed) throw new TypeError("Recording is not active");
      return this.get(id) as Recording;
    });
  }

  /** Review deletions: keeps only the listed steps, renumbered, before anything reaches a model. */
  keepSteps(id: string, keep: readonly number[]): Recording {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (current?.status !== "review") throw new TypeError("Recording not in review");
      const wanted = new Set(keep);
      const steps = current.steps
        .filter((step) => wanted.has(step.index))
        .map((step, index) => ({ ...step, index }));
      if (!steps.length) throw new TypeError("No steps kept");
      this.db.prepare("UPDATE recordings SET steps=? WHERE id=?").run(JSON.stringify(steps), id);
      return this.get(id) as Recording;
    });
  }

  /** Startup recovery: a recording cannot survive a restart of the browser that produced it. */
  failActive(): number {
    return Number(
      this.db
        .prepare("UPDATE recordings SET status='failed',ended_at=? WHERE status='recording'")
        .run(new Date().toISOString()).changes,
    );
  }

  setStatus(id: string, status: RecordingStatus): Recording {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) throw new TypeError("Unknown recording");
      if (!NEXT[current.status].includes(status)) throw new TypeError("Invalid recording status");
      const endedAt = current.endedAt ?? new Date().toISOString();
      this.db
        .prepare("UPDATE recordings SET status=?,ended_at=? WHERE id=?")
        .run(status, endedAt, current.id);
      return this.get(id) as Recording;
    });
  }
}
