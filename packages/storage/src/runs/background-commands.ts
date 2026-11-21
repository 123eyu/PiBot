import type { DatabaseSync } from "node:sqlite";
import {
  type BackgroundCommand,
  BackgroundCommandStatusSchema,
  type BackgroundPlace,
  BackgroundStopReasonSchema,
  IdSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

/** What a restarted brain needs to find the processes again (pid + start time identity). */
export interface BackgroundProcesses {
  group: number;
  processes: { pid: number; started: string }[];
}
export type BackgroundCommandRow = Omit<BackgroundCommand, "ports" | "portsVisible"> & {
  logPath: string;
};

const ProcessesSchema = z
  .array(z.strictObject({ pid: z.number().int().positive(), started: z.string().max(100) }))
  .max(512);

const columns =
  "id,bot_id AS botId,conversation_id AS conversationId,group_id AS groupId,run_id AS runId,tool_call_id AS toolCallId,command,log_path AS logPath,status,stop_reason AS stopReason,exit_code AS exitCode,started_at AS startedAt,ended_at AS endedAt";

function parse(row: Record<string, unknown>): BackgroundCommandRow {
  return {
    id: IdSchema.parse(row.id),
    botId: IdSchema.parse(row.botId),
    conversationId: row.conversationId === null ? null : IdSchema.parse(row.conversationId),
    groupId: row.groupId === null ? null : IdSchema.parse(row.groupId),
    runId: IdSchema.parse(row.runId),
    toolCallId: String(row.toolCallId),
    command: String(row.command),
    logPath: String(row.logPath),
    status: BackgroundCommandStatusSchema.parse(row.status),
    stopReason:
      row.stopReason === null
        ? null
        : (BackgroundStopReasonSchema.safeParse(row.stopReason).data ?? null),
    exitCode: row.exitCode === null ? null : Number(row.exitCode),
    startedAt: String(row.startedAt),
    endedAt: row.endedAt === null ? null : String(row.endedAt),
  };
}

const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : null);
function placeOf(row: Record<string, unknown>): BackgroundPlace | null {
  const groupName = short(row.groupName);
  if (row.placeKind === "dm")
    return { kind: "topic", title: short(row.placeTitle) ?? "", groupName };
  if (row.placeKind === "group")
    return { kind: "group", title: groupName ?? short(row.placeTitle) ?? "", groupName };
  if (row.placeKind === "thread")
    return {
      kind: "thread",
      title: short(row.taskTitle) ?? short(row.placeTitle) ?? "",
      groupName,
    };
  return null;
}

/** Background commands: one row per started command, kept as history after it ends. */
export class BackgroundCommandsRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: Omit<BackgroundCommandRow, "status" | "stopReason" | "exitCode" | "endedAt">) {
    this.db
      .prepare(
        "INSERT INTO background_commands(id,bot_id,conversation_id,group_id,run_id,tool_call_id,command,log_path,status,started_at) VALUES (?,?,?,?,?,?,?,?,'running',?)",
      )
      .run(
        row.id,
        row.botId,
        row.conversationId,
        row.groupId,
        row.runId,
        row.toolCallId,
        row.command,
        row.logPath,
        row.startedAt,
      );
  }

  get(id: string): BackgroundCommandRow | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM background_commands WHERE id=?`).get(id);
    return row ? parse(row) : undefined;
  }

  conversationBusy(conversationId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM background_commands WHERE conversation_id=? AND (status='running' OR stop_reason='restart_unverified') LIMIT 1",
      )
      .get(IdSchema.parse(conversationId));
  }

  /** Newest first (running and ended), bounded. */
  list(botId: string, limit = 50, conversationId?: string): BackgroundCommandRow[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM background_commands WHERE bot_id=? AND (? IS NULL OR conversation_id=?) ORDER BY status='running' DESC, COALESCE(ended_at,started_at) DESC, id DESC LIMIT ?`,
      )
      .all(botId, conversationId ?? null, conversationId ?? null, Math.min(Math.max(limit, 1), 50))
      .map(parse);
  }

  /**
   * Records page. Running rows by start time, ended rows by end time (newest first), keyset
   * paged on (time, id); the chat it was started in comes along so the UI needs no extra lookups.
   * No extra index: rows older than 30 days are pruned, so the table stays a few hundred rows.
   */
  page(query: {
    ids?: string[];
    from?: string;
    state: "running" | "ended";
    groupId?: string;
    botId?: string;
    before?: string;
    limit?: number;
  }): (BackgroundCommandRow & { place: BackgroundPlace | null })[] {
    const time = query.state === "running" ? "b.started_at" : "b.ended_at";
    const where = [query.state === "running" ? "b.status='running'" : "b.status<>'running'"];
    const args: (string | number)[] = [];
    if (query.ids) {
      const ids = query.ids.slice(0, 32).map((id) => IdSchema.parse(id));
      if (!ids.length) return [];
      where.push(`b.id IN (${ids.map(() => "?").join(",")})`);
      args.push(...ids);
    }
    if (query.botId) {
      where.push("b.bot_id=?");
      args.push(IdSchema.parse(query.botId));
    }
    if (query.groupId) {
      where.push("b.group_id=?");
      args.push(IdSchema.parse(query.groupId));
    }
    if (query.from) {
      where.push(`${time}>=?`);
      args.push(query.from);
    }
    if (query.before) {
      const cursor = this.db
        .prepare(
          `SELECT ${time} AS at FROM background_commands b WHERE b.id=?${query.groupId ? " AND b.group_id=?" : ""}`,
        )
        .get(
          IdSchema.parse(query.before),
          ...(query.groupId ? [IdSchema.parse(query.groupId)] : []),
        );
      // A pruned or foreign cursor would silently restart the list; make the caller reload.
      if (!cursor || cursor.at === null) throw new RangeError("Unknown background cursor");
      where.push(`(${time} < ? OR (${time} = ? AND b.id < ?))`);
      args.push(String(cursor.at), String(cursor.at), query.before);
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const prefixed = columns
      .split(",")
      .map((column) => `b.${column}`)
      .join(",");
    return this.db
      .prepare(
        `SELECT ${prefixed},c.kind AS placeKind,c.title AS placeTitle,g.name AS groupName,t.title AS taskTitle
          FROM background_commands b
          LEFT JOIN conversations c ON c.id=b.conversation_id
          LEFT JOIN groups g ON g.id=b.group_id
          LEFT JOIN group_tasks t ON t.thread_conversation_id=b.conversation_id
          WHERE ${where.join(" AND ")}
          ORDER BY ${time} DESC, b.id DESC LIMIT ?`,
      )
      .all(...args, limit)
      .map((row) => ({ ...parse(row), place: placeOf(row) }));
  }

  /** Rows a previous brain left as running, with their recorded processes. */
  running(): (BackgroundCommandRow & BackgroundProcesses)[] {
    return this.db
      .prepare(
        `SELECT ${columns},process_group AS processGroup,processes FROM background_commands WHERE status='running' LIMIT 500`,
      )
      .all()
      .map((row) => ({
        ...parse(row),
        group: Number(row.processGroup ?? 0),
        processes: ProcessesSchema.safeParse(JSON.parse(String(row.processes))).data ?? [],
      }));
  }

  setProcesses(id: string, value: BackgroundProcesses) {
    this.db
      .prepare("UPDATE background_commands SET process_group=?, processes=? WHERE id=?")
      .run(value.group, JSON.stringify(ProcessesSchema.parse(value.processes.slice(0, 512))), id);
  }

  finish(
    id: string,
    value: Pick<BackgroundCommandRow, "status" | "stopReason" | "exitCode">,
    at = new Date().toISOString(),
  ) {
    this.db
      .prepare(
        "UPDATE background_commands SET status=?, stop_reason=?, exit_code=?, ended_at=?, processes=CASE WHEN ?='restart_unverified' THEN processes ELSE '[]' END WHERE id=? AND status='running'",
      )
      .run(value.status, value.stopReason, value.exitCode, at, value.stopReason, id);
  }

  hasUnverified(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM background_commands WHERE stop_reason='restart_unverified' LIMIT 1")
      .get();
  }

  unverified(after = ""): (BackgroundCommandRow & BackgroundProcesses)[] {
    return this.db
      .prepare(
        `SELECT ${columns},process_group AS processGroup,processes FROM background_commands WHERE stop_reason='restart_unverified' AND id>? ORDER BY id LIMIT 500`,
      )
      .all(after)
      .map((row) => ({
        ...parse(row),
        group: Number(row.processGroup ?? 0),
        processes: ProcessesSchema.safeParse(JSON.parse(String(row.processes))).data ?? [],
      }));
  }

  confirmStopped(id: string) {
    this.db
      .prepare(
        "UPDATE background_commands SET stop_reason='restart', processes='[]' WHERE id=? AND stop_reason='restart_unverified'",
      )
      .run(id);
  }

  /** History beyond 30 days is not shown anywhere; keep the table small. */
  prune(now = Date.now()) {
    this.db
      .prepare(
        "DELETE FROM background_commands WHERE status<>'running' AND stop_reason IS NOT 'restart_unverified' AND ended_at < ?",
      )
      .run(new Date(now - 30 * 86_400_000).toISOString());
  }
}
