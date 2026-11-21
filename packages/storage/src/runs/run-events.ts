import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/database.ts";

export interface RunEvent {
  seq: number;
  runId: string | null;
  conversationId: string | null;
  kind: string;
  at: string;
  payload: unknown;
  sessionEntryId: string | null;
}

export interface PublicRunEvent {
  seq: number;
  runId: string;
  conversationId: string | null;
  kind: string;
  at: string;
}

export interface PublicRunEventPage {
  events: PublicRunEvent[];
  hasMore: boolean;
  settled: boolean;
}

export interface AppendRunEvent {
  runId: string;
  conversationId: string;
  kind: string;
  payload?: unknown;
  at?: string;
  sessionEntryId?: string | null;
}

export interface RunEventState {
  runId: string;
  conversationId: string;
  created: boolean;
  started: boolean;
  terminal: null | { status: string; stopReason: string | null; errorCode: string | null };
  interrupted: boolean;
  latestSeq: number;
}

export interface SessionTailCandidate {
  file: string;
  runId: string;
  botId: string;
  conversationId: string;
  runKind: string;
  runStatus: string;
  factSeq: number;
  marker: null | {
    seq: number;
    kind: string;
    throughSeq: number;
    sessionEntryId: string | null;
  };
}

const TOOL_RESULT_INLINE_BYTES = 8 * 1024;

function parse(row: Record<string, unknown>): RunEvent {
  return {
    seq: Number(row.seq),
    runId: row.runId === null ? null : String(row.runId),
    conversationId: row.conversationId === null ? null : String(row.conversationId),
    kind: String(row.kind),
    at: String(row.at),
    payload: JSON.parse(String(row.payload)),
    sessionEntryId: row.sessionEntryId === null ? null : String(row.sessionEntryId),
  };
}

// Terminal lifecycle events always land after the drain's session marker and can never add JSONL;
// leaving them out of the fact watermark is what lets a settled session be skipped at startup
//.
const TERMINAL_KINDS = "'run.finished','run.interrupted','run.stopped','run.sealed'";
const notTerminal = (alias: string) => `${alias}.kind NOT IN (${TERMINAL_KINDS})`;

const columns = `seq,run_id AS runId,conversation_id AS conversationId,kind,at,payload,
  session_entry_id AS sessionEntryId`;
const publicColumns = `seq,run_id AS runId,conversation_id AS conversationId,kind,at`;

function parsePublic(row: Record<string, unknown>): PublicRunEvent {
  return {
    seq: Number(row.seq),
    runId: String(row.runId),
    conversationId: row.conversationId === null ? null : String(row.conversationId),
    kind: String(row.kind),
    at: String(row.at),
  };
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Append-only authoritative facts. Callers that mutate projections own the surrounding transaction. */
export class RunEventsRepo {
  constructor(private readonly db: DatabaseSync) {}

  append(input: AppendRunEvent): RunEvent {
    if (!input.runId || !input.conversationId) throw new TypeError("Run event identity required");
    return this.insert(input.runId, input.conversationId, input.kind, input.payload ?? {}, input);
  }

  /** Idempotent durable watermark written only after every run-scoped producer has drained. */
  sealTerminal(runId: string): RunEvent | undefined {
    if (!runId) throw new TypeError("Run event identity required");
    const existing = this.db
      .prepare(`SELECT ${columns} FROM run_events WHERE run_id=? AND kind='run.sealed' LIMIT 1`)
      .get(runId);
    if (existing) return parse(existing);
    const run = this.db
      .prepare(
        `SELECT conversation_id AS conversationId,status,stop_reason AS stopReason,
           error_code AS errorCode
         FROM runs WHERE id=? AND status IN ('done','error','aborted') AND finished_at IS NOT NULL`,
      )
      .get(runId);
    if (!run) return undefined;
    return this.insert(
      runId,
      String(run.conversationId),
      "run.sealed",
      {
        status: String(run.status),
        stopReason: run.stopReason === null ? null : String(run.stopReason),
        errorCode: run.errorCode === null ? null : String(run.errorCode),
      },
      {},
    );
  }

  latestRunRowId(): number {
    return Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS rowId FROM runs").get()?.rowId);
  }

  /** Upgrade bridge called after every startup recovery owner has appended its corrections. */
  sealTerminalPage(
    after = "",
    limit = 200,
    maxRunRowId = Number.MAX_SAFE_INTEGER,
  ): { count: number; last: string } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new TypeError("Invalid terminal seal limit");
    if (!Number.isSafeInteger(maxRunRowId) || maxRunRowId < 0)
      throw new TypeError("Invalid terminal seal snapshot");
    const rows = this.db
      .prepare(
        `SELECT id FROM runs r WHERE id>? AND r.rowid<=? AND status IN ('done','error','aborted')
           AND finished_at IS NOT NULL AND NOT EXISTS
             (SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.kind='run.sealed')
         ORDER BY id LIMIT ?`,
      )
      .all(after, maxRunRowId, limit);
    transaction(this.db, () => {
      for (const row of rows) this.sealTerminal(String(row.id));
    });
    return { count: rows.length, last: rows.length ? String(rows.at(-1)?.id) : after };
  }

  after(seq: number, limit = 200, kindPrefix?: string): RunEvent[] {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("Invalid event cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new TypeError("Invalid event limit");
    const rows = kindPrefix
      ? this.db
          .prepare(
            `SELECT ${columns} FROM run_events WHERE seq>? AND kind LIKE ? ORDER BY seq LIMIT ?`,
          )
          .all(seq, `${kindPrefix}%`, limit)
      : this.db
          .prepare(`SELECT ${columns} FROM run_events WHERE seq>? ORDER BY seq LIMIT ?`)
          .all(seq, limit);
    return rows.map(parse);
  }

  /** Reads only public metadata and one look-ahead row; raw payloads never enter this path. */
  publicPage(runId: string, afterSeq: number, limit = 200): PublicRunEventPage {
    if (!runId) throw new TypeError("Run event identity required");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new TypeError("Invalid event cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new TypeError("Invalid event limit");
    const rows = this.db
      .prepare(
        `SELECT ${publicColumns} FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(runId, afterSeq, limit + 1);
    const events = rows.slice(0, limit).map(parsePublic);
    const hasMore = rows.length > limit;
    const throughSeq = events.at(-1)?.seq ?? afterSeq;
    const sealed = this.db
      .prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='run.sealed' AND seq<=? LIMIT 1")
      .get(runId, throughSeq);
    return { events, hasMore, settled: !hasMore && !!sealed };
  }

  latestSeq(): number {
    return Number(
      this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM run_events").get()?.seq ?? 0,
    );
  }

  /** Authoritative lifecycle facts used before any recovery path consults mutable projections. */
  state(runId: string): RunEventState | undefined {
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM run_events
         WHERE run_id=? AND kind IN ('run.created','run.started','run.finished','run.interrupted')
         ORDER BY seq`,
      )
      .all(runId)
      .map(parse);
    const first = rows[0];
    if (!first?.conversationId) return undefined;
    let created = false,
      started = false,
      interrupted = false,
      terminal: RunEventState["terminal"] = null;
    for (const event of rows) {
      if (event.conversationId !== first.conversationId) return undefined;
      const payload = objectPayload(event.payload);
      if (event.kind === "run.created") created = true;
      else if (event.kind === "run.started") started = true;
      else if (event.kind === "run.interrupted") {
        interrupted = true;
        if (terminal)
          terminal = {
            status: typeof payload.status === "string" ? payload.status : terminal.status,
            stopReason:
              typeof payload.stopReason === "string" ? payload.stopReason : terminal.stopReason,
            errorCode:
              typeof payload.errorCode === "string" ? payload.errorCode : terminal.errorCode,
          };
      } else if (event.kind === "run.finished") {
        terminal = {
          status: typeof payload.status === "string" ? payload.status : "",
          stopReason: typeof payload.stopReason === "string" ? payload.stopReason : null,
          errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
        };
        if (terminal.stopReason === "interrupted") interrupted = true;
      }
    }
    return {
      runId,
      conversationId: first.conversationId,
      created,
      started,
      terminal,
      interrupted,
      latestSeq: rows.at(-1)?.seq ?? 0,
    };
  }

  /** Event authority for a parked routine call; JSONL may supply args, never execution state. */
  pendingToolCall(runId: string, conversationId: string, toolCallId: string) {
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM run_events
         WHERE run_id=? AND conversation_id=? AND kind IN ('tool.called','tool.result')
         AND json_extract(payload,'$.toolCallId')=? ORDER BY seq`,
      )
      .all(runId, conversationId, toolCallId)
      .map(parse);
    let called: { seq: number; tool: string } | undefined;
    for (const event of rows) {
      if (event.kind === "tool.result") called = undefined;
      else {
        const payload = objectPayload(event.payload);
        if (typeof payload.tool !== "string") return undefined;
        called = { seq: event.seq, tool: payload.tool };
      }
    }
    return called;
  }

  /**
   * Bounded, keyset-paged inventory: one newest run owns reconciliation for each JSONL file.
   * One statement per page. Asked file by file, the fact and marker lookups had to find
   * runs by `session_file` (no index), so SQLite scanned `run_events` once per session and this
   * sweep dominated startup; driven from the page's runs, every event lookup is an index seek.
   * Materialize page_runs once and preserve that outer-loop order for both event lookups.
   * A synthetic 360-session/7,200-run sweep fell from 439–479 ms to 131–139 ms with equal rows.
   */
  sessionTailCandidates(after = "", limit = 100): SessionTailCandidate[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new TypeError("Invalid session candidate limit");
    return this.db
      .prepare(
        `WITH page AS (
           SELECT session_file AS file FROM runs
           WHERE session_file IS NOT NULL AND session_file>? GROUP BY session_file
           ORDER BY session_file LIMIT ?
         ),
         page_runs AS MATERIALIZED (
           SELECT r.session_file AS file,r.rowid AS runRow,r.id AS runId,r.bot_id AS botId,
             r.conversation_id AS conversationId,r.kind AS runKind,r.status AS runStatus
           FROM page p JOIN runs r ON r.session_file=p.file
         ),
         owner AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY file ORDER BY runRow DESC) AS n
           FROM page_runs
         ),
         -- Each run's newest fact / marker is one backwards step on run_events(run_id, seq); joining
         -- every event of every run read all 115k rows of a real database at each startup (3.7 s
         -- of the brain's critical path, 2026-11-11). Same answers, per run then per session file.
         facts AS (
           SELECT r.file,MAX((
             SELECT e.seq FROM run_events e
             WHERE e.run_id=r.runId AND e.kind NOT LIKE 'session.%' AND ${notTerminal("e")}
             ORDER BY e.seq DESC LIMIT 1)) AS seq
           FROM page_runs r GROUP BY r.file
         ),
         -- Materialize the per-run lookup so WHERE and MAX do not each re-run it.
         run_markers AS MATERIALIZED (
           SELECT r.file,(
             SELECT e.seq FROM run_events e
             WHERE e.run_id=r.runId
               AND e.kind IN ('session.synced','session.backfilled','session.interrupted')
             ORDER BY e.seq DESC LIMIT 1) AS seq
           FROM page_runs r
         ),
         markers AS (
           SELECT file,MAX(seq) AS seq FROM run_markers WHERE seq IS NOT NULL GROUP BY file
         )
         SELECT o.file,o.runId,o.botId,o.conversationId,o.runKind,o.runStatus,
           COALESCE(f.seq,0) AS factSeq,me.seq AS markerSeq,me.kind AS markerKind,
           me.payload AS markerPayload,me.session_entry_id AS markerEntryId
         FROM owner o LEFT JOIN facts f ON f.file=o.file
         LEFT JOIN markers m ON m.file=o.file
         LEFT JOIN run_events me ON me.seq=m.seq
         WHERE o.n=1 ORDER BY o.file`,
      )
      .all(after, limit)
      .map((row) => {
        const markerPayload =
          row.markerSeq === null ? {} : objectPayload(JSON.parse(String(row.markerPayload)));
        return {
          file: String(row.file),
          runId: String(row.runId),
          botId: String(row.botId),
          conversationId: String(row.conversationId),
          runKind: String(row.runKind),
          runStatus: String(row.runStatus),
          factSeq: Number(row.factSeq),
          marker:
            row.markerSeq === null
              ? null
              : {
                  seq: Number(row.markerSeq),
                  kind: String(row.markerKind),
                  throughSeq:
                    typeof markerPayload.throughSeq === "number" &&
                    Number.isSafeInteger(markerPayload.throughSeq)
                      ? markerPayload.throughSeq
                      : 0,
                  sessionEntryId: row.markerEntryId === null ? null : String(row.markerEntryId),
                },
        };
      });
  }

  /**
   * Fact watermark a session marker records. Terminal lifecycle events never add JSONL and always
   * land after the drain's marker, so counting them would leave every finished session looking
   * ahead of its watermark and re-read its whole JSONL at each startup.
   */
  sessionFactSeq(file: string): number {
    return Number(
      this.db
        .prepare(
          `SELECT COALESCE(MAX(e.seq),0) AS seq FROM run_events e
           JOIN runs r ON r.id=e.run_id
           WHERE r.session_file=? AND e.kind NOT LIKE 'session.%' AND ${notTerminal("e")}`,
        )
        .get(file)?.seq ?? 0,
    );
  }

  /** One-time bridge for runs created before 0082; later recovery still reads only events. */
  backfillLegacyLifecycle(after = "", limit = 200): { count: number; last: string } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new TypeError("Invalid lifecycle backfill limit");
    const rows = this.db
      .prepare(
        `SELECT id,conversation_id AS conversationId,kind,status,stop_reason AS stopReason,
           error_code AS errorCode,automatic,created_at AS createdAt,started_at AS startedAt,
           finished_at AS finishedAt FROM runs r WHERE id>? AND NOT EXISTS
           (SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.kind='run.created')
         ORDER BY id LIMIT ?`,
      )
      .all(after, limit);
    transaction(this.db, () => {
      for (const row of rows) {
        const runId = String(row.id),
          conversationId = String(row.conversationId);
        this.append({
          runId,
          conversationId,
          kind: "run.created",
          at: String(row.createdAt),
          payload: {
            status: "queued",
            runKind: String(row.kind),
            automatic: row.automatic === 1,
            source: "legacy_projection",
          },
        });
        if (row.startedAt !== null)
          this.append({
            runId,
            conversationId,
            kind: "run.started",
            at: String(row.startedAt),
            payload: { status: "running", source: "legacy_projection" },
          });
        if (row.finishedAt !== null) {
          this.append({
            runId,
            conversationId,
            kind: "run.finished",
            at: String(row.finishedAt),
            payload: {
              status: String(row.status),
              stopReason: row.stopReason === null ? null : String(row.stopReason),
              errorCode: row.errorCode === null ? null : String(row.errorCode),
              source: "legacy_projection",
            },
          });
        }
      }
    });
    return { count: rows.length, last: rows.length ? String(rows.at(-1)?.id) : after };
  }

  /**
   * Keeps the event row small. The supplied summary must already have crossed the brain redactor;
   * this layer deliberately has no access to secrets or to raw tool arguments.
   */
  toolResultPayload(summary: string): {
    summary: string;
    result?: { path: string; bytes: number };
  } {
    const bytes = Buffer.byteLength(summary, "utf8");
    if (bytes <= TOOL_RESULT_INLINE_BYTES) return { summary };
    const root = this.dataRoot();
    const directory = join(root, "run-events");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error("Invalid run event result directory");
    chmodSync(directory, 0o700);
    const name = `${randomUUID()}.txt`;
    const target = join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, summary, { encoding: "utf8" });
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, target);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {
        // A failed open creates nothing; a failed cleanup is handled later as an orphan by T10c.
      }
      throw error;
    }
    return {
      summary: Buffer.from(summary, "utf8").subarray(0, TOOL_RESULT_INLINE_BYTES).toString("utf8"),
      result: { path: relative(root, target).split(sep).join("/"), bytes },
    };
  }

  private dataRoot(): string {
    const row = this.db
      .prepare("PRAGMA database_list")
      .all()
      .find((entry) => entry.name === "main");
    const file = String(row?.file ?? "");
    if (!file) throw new Error("Run event files require a file-backed database");
    const root = resolve(dirname(file));
    if (root === resolve(sep)) throw new Error("Invalid run event data directory");
    return root;
  }

  private insert(
    runId: string | null,
    conversationId: string | null,
    kind: string,
    payload: unknown,
    meta: { at?: string; sessionEntryId?: string | null },
    maxPayloadBytes?: number,
  ): RunEvent {
    if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(kind)) throw new TypeError("Invalid run event kind");
    const encoded = JSON.stringify(payload);
    if (
      encoded === undefined ||
      (maxPayloadBytes !== undefined && Buffer.byteLength(encoded, "utf8") > maxPayloadBytes)
    )
      throw new TypeError("Run event payload too large");
    const at = meta.at ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO run_events(run_id,conversation_id,kind,at,payload,session_entry_id)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(runId, conversationId, kind, at, encoded, meta.sessionEntryId ?? null);
    const row = this.db
      .prepare(`SELECT ${columns} FROM run_events WHERE seq=?`)
      .get(result.lastInsertRowid);
    if (!row) throw new Error("Run event append failed");
    return parse(row);
  }
}
