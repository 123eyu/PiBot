import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ExecutionScope,
  IdSchema,
  type TaskPage,
  type TaskStatus,
  type TaskSummary,
  TaskSummarySchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";
import { type TaskAuthority, TaskAuthoritySchema } from "./task-authority.ts";
import { TaskInputsRepo } from "./task-inputs.ts";

const columns = `id,bot_id AS botId,source_conversation_id AS conversationId,
 parent_task_id AS parentTaskId,root_run_id AS rootRunId,parent_run_id AS parentRunId,
 tool_call_id AS sourceToolCallId,
 run_id AS runId,title,status,version,created_at AS createdAt,updated_at AS updatedAt,result,
 result_truncated AS resultTruncated,needs_verification AS needsVerification,
 archived_at AS archivedAt,deleted_at AS deletedAt`;
function decode(row: Record<string, unknown>): TaskSummary {
  return TaskSummarySchema.parse({
    ...row,
    resultTruncated: !!row.resultTruncated,
    needsVerification: !!row.needsVerification,
  });
}
export class TaskConflictError extends Error {
  constructor() {
    super("task_version_changed");
  }
}
export class TaskRepo {
  readonly inputs: TaskInputsRepo;
  constructor(private readonly db: DatabaseSync) {
    this.inputs = new TaskInputsRepo(db);
  }
  get(id: string): TaskSummary | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM task_instances WHERE id=?`)
      .get(IdSchema.parse(id));
    return row ? decode(row) : undefined;
  }
  internal(id: string) {
    const row = this.db
      .prepare(`SELECT authority_json,internal_conversation_id,prompt,depth
      FROM task_instances WHERE id=?`)
      .get(IdSchema.parse(id));
    if (!row) return undefined;
    return {
      authority: TaskAuthoritySchema.parse(JSON.parse(String(row.authority_json))),
      conversationId: String(row.internal_conversation_id),
      prompt: String(row.prompt),
      depth: Number(row.depth),
    };
  }
  forRun(runId: string) {
    const row = this.db.prepare("SELECT task_id FROM task_attempts WHERE run_id=?").get(runId);
    return row ? this.get(String(row.task_id)) : undefined;
  }
  previousRun(taskId: string, runId: string) {
    const row = this.db
      .prepare(`SELECT run_id FROM task_attempts WHERE task_id=? AND attempt<
      (SELECT attempt FROM task_attempts WHERE run_id=?) ORDER BY attempt DESC LIMIT 1`)
      .get(taskId, runId);
    return row ? String(row.run_id) : undefined;
  }
  duplicate(parentRunId: string, toolCallId: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM task_instances WHERE parent_run_id=? AND tool_call_id=?`)
      .get(parentRunId, toolCallId);
    return row ? decode(row) : undefined;
  }
  isInternalConversation(id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM conversations WHERE id=? AND internal_task_id IS NOT NULL")
      .get(id);
  }
  sourceBusy(id: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM task_instances WHERE source_conversation_id=?
      AND status IN ('queued','running','stopping') LIMIT 1`)
      .get(id);
  }
  sourceBackgroundBusy(id: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM background_commands b JOIN task_instances t
      ON b.conversation_id=t.internal_conversation_id
      WHERE t.source_conversation_id=? AND b.status='running' LIMIT 1`)
      .get(id);
  }
  list(
    scope: ExecutionScope,
    page: {
      before?: string;
      limit?: number;
      rootRunId?: string;
      parentTaskId?: string | null;
      archived?: boolean;
    } = {},
  ): TaskPage {
    const limit = Math.min(50, Math.max(1, page.limit ?? 25));
    const rows = readPage(
      this.db,
      "task_instances",
      columns,
      "created_at",
      { before: page.before, limit: limit + 1 },
      [
        ["bot_id", scope.botId],
        ["source_conversation_id", scope.conversationId],
        ["deleted_at", null],
        ["(archived_at IS NOT NULL)", page.archived ? 1 : 0],
        ...(page.rootRunId ? [["root_run_id", page.rootRunId] as const] : []),
        ...(page.parentTaskId !== undefined
          ? [["parent_task_id", page.parentTaskId] as const]
          : []),
      ],
      [
        ["bot_id", scope.botId],
        ["source_conversation_id", scope.conversationId],
        ...(page.rootRunId ? [["root_run_id", page.rootRunId] as const] : []),
        ...(page.parentTaskId !== undefined
          ? [["parent_task_id", page.parentTaskId] as const]
          : []),
      ],
    );
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(decode);
    return { items, nextBefore: more ? (items.at(-1)?.id ?? null) : null };
  }
  create(input: {
    id?: string;
    parentTaskId: string | null;
    rootRunId: string;
    parentRunId: string;
    toolCallId: string;
    title: string;
    prompt: string;
    authority: TaskAuthority;
    depth: number;
  }) {
    const authority = TaskAuthoritySchema.parse(input.authority);
    return transaction(this.db, () => {
      const duplicate = this.duplicate(input.parentRunId, input.toolCallId);
      if (duplicate) return duplicate;
      const id = input.id ?? randomUUID(),
        conversationId = randomUUID(),
        now = new Date().toISOString();
      const value = TaskSummarySchema.parse({
        id,
        botId: authority.source.botId,
        conversationId: authority.source.conversationId,
        parentTaskId: input.parentTaskId,
        rootRunId: input.rootRunId,
        parentRunId: input.parentRunId,
        sourceToolCallId: input.toolCallId,
        runId: null,
        title: input.title,
        status: "queued",
        version: 1,
        createdAt: now,
        updatedAt: now,
        result: null,
        resultTruncated: false,
        needsVerification: false,
      });
      this.db
        .prepare(`INSERT INTO conversations(id,kind,bot_id,pi_session_file,created_at,updated_at,internal_task_id)
        VALUES (?,'dm',?,NULL,?,?,?)`)
        .run(conversationId, value.botId, now, now, id);
      this.db
        .prepare(`INSERT INTO task_instances(id,bot_id,source_conversation_id,parent_task_id,root_run_id,
        parent_run_id,internal_conversation_id,tool_call_id,title,prompt,authority_json,depth,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          id,
          value.botId,
          value.conversationId,
          input.parentTaskId,
          input.rootRunId,
          input.parentRunId,
          conversationId,
          input.toolCallId,
          value.title,
          input.prompt.slice(0, 16_000),
          JSON.stringify(authority),
          input.depth,
          "queued",
          now,
          now,
        );
      return value;
    });
  }
  attempt(taskId: string, runId: string, expectedVersion: number) {
    return transaction(this.db, () => {
      const task = this.get(taskId),
        internal = this.internal(taskId);
      if (!task || !internal || task.version !== expectedVersion) throw new TaskConflictError();
      const row = this.db
        .prepare("SELECT COALESCE(MAX(attempt),0)+1 AS n FROM task_attempts WHERE task_id=?")
        .get(taskId);
      this.db
        .prepare(
          "INSERT INTO task_attempts(run_id,task_id,internal_conversation_id,attempt,created_at) VALUES(?,?,?,?,?)",
        )
        .run(runId, taskId, internal.conversationId, Number(row?.n), new Date().toISOString());
      // A resume must open a fresh SDK session. Old paths remain in BotSessions/history.
      this.db
        .prepare("UPDATE conversations SET pi_session_file=NULL WHERE id=?")
        .run(internal.conversationId);
      this.db
        .prepare("DELETE FROM bot_sessions WHERE conversation_id=?")
        .run(internal.conversationId);
      return this.update(taskId, expectedVersion, { runId, status: "queued" });
    });
  }
  update(
    id: string,
    expectedVersion: number,
    patch: {
      runId?: string;
      status?: TaskStatus;
      result?: string;
      needsVerification?: boolean;
    },
  ) {
    return transaction(this.db, () => {
      const old = this.get(id);
      if (!old || old.version !== expectedVersion) throw new TaskConflictError();
      const next = TaskSummarySchema.parse({
        ...old,
        ...patch,
        ...(patch.result !== undefined
          ? { result: patch.result.slice(0, 16_000), resultTruncated: patch.result.length > 16_000 }
          : {}),
        version: old.version + 1,
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare(`UPDATE task_instances SET run_id=?,status=?,result=?,result_truncated=?,needs_verification=?,version=?,updated_at=?
        WHERE id=? AND version=?`)
        .run(
          next.runId,
          next.status,
          next.result,
          Number(next.resultTruncated),
          Number(next.needsVerification),
          next.version,
          next.updatedAt,
          id,
          expectedVersion,
        );
      return next;
    });
  }
  recover() {
    this.db
      .prepare(`UPDATE task_instances SET status='interrupted',version=version+1,updated_at=?,
      needs_verification=CASE WHEN EXISTS(SELECT 1 FROM execution_checkpoints c WHERE c.run_id=task_instances.run_id
        AND json_extract(c.checkpoint_json,'$.sideEffectsPossible')=1) THEN 1 ELSE needs_verification END
      WHERE status IN ('queued','running','stopping')`)
      .run(new Date().toISOString());
  }
}
