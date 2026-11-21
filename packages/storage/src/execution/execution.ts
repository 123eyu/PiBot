import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_EXECUTION_LIMITS,
  type ExecutionScope,
  ExecutionScopeSchema,
  type ExecutionSettings,
  ExecutionSettingsSchema,
  type TodoPlan,
  TodoPlanSchema,
  TodoSourceSchema,
  type TodoUpdate,
  TodoUpdateSchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

export class ExecutionConflictError extends Error {
  constructor() {
    super("execution_version_changed");
  }
}

/** The caller validates Bot/topic membership; repositories only own persistence and atomic CAS. */
export class ExecutionRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(scope: ExecutionScope): ExecutionSettings {
    const ids = ExecutionScopeSchema.parse(scope);
    const row = this.db
      .prepare("SELECT * FROM execution_settings WHERE bot_id=? AND conversation_id=?")
      .get(ids.botId, ids.conversationId);
    return ExecutionSettingsSchema.parse({
      ...ids,
      mode: row?.mode ?? "execute",
      limits: row ? JSON.parse(String(row.limits_json)) : { ...DEFAULT_EXECUTION_LIMITS },
      version: row ? Number(row.version) : 0,
      updatedAt: row ? String(row.updated_at) : null,
    });
  }

  set(
    scope: ExecutionScope,
    input: Pick<ExecutionSettings, "mode"> & {
      expectedVersion: number;
      limits?: ExecutionSettings["limits"];
    },
  ): ExecutionSettings {
    return transaction(this.db, () => {
      const previous = this.get(scope);
      if (previous.version !== input.expectedVersion) throw new ExecutionConflictError();
      const next = ExecutionSettingsSchema.parse({
        ...previous,
        mode: input.mode,
        limits: input.limits ?? previous.limits,
        version: previous.version + 1,
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare(
          `INSERT INTO execution_settings
           (bot_id, conversation_id, mode, limits_json, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(bot_id, conversation_id) DO UPDATE SET
           mode=excluded.mode, limits_json=excluded.limits_json, version=excluded.version,
           updated_at=excluded.updated_at`,
        )
        .run(
          next.botId,
          next.conversationId,
          next.mode,
          JSON.stringify(next.limits),
          next.version,
          next.updatedAt,
        );
      return next;
    });
  }

  private readTodo(scope: ExecutionScope) {
    const ids = ExecutionScopeSchema.parse(scope);
    const row = this.db
      .prepare("SELECT * FROM execution_todo WHERE bot_id=? AND conversation_id=?")
      .get(ids.botId, ids.conversationId);
    const body = row ? JSON.parse(String(row.plan_json)) : { goal: "", items: [] };
    const plan = TodoPlanSchema.parse({
      ...body,
      ...ids,
      source: body.source ?? null,
      version: row ? Number(row.version) : 0,
      updatedAt: row ? String(row.updated_at) : null,
    });
    return { plan, legacySource: !!row && !Object.hasOwn(body, "source") };
  }

  todo(scope: ExecutionScope): TodoPlan {
    return this.readTodo(scope).plan;
  }

  /** Only trusted collection snapshots may replace the first-update receipt. */
  replaceTodoSnapshot(
    scope: ExecutionScope,
    expectedVersion: number,
    snapshot: Pick<TodoPlan, "goal" | "items" | "source">,
  ) {
    const previous = this.todo(scope);
    if (previous.version !== expectedVersion) throw new ExecutionConflictError();
    const next = TodoPlanSchema.parse({
      ...previous,
      ...snapshot,
      source: snapshot.source ?? null,
      version: previous.version + 1,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(`INSERT INTO execution_todo(bot_id,conversation_id,plan_json,version,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(bot_id,conversation_id) DO UPDATE SET
      plan_json=excluded.plan_json,version=excluded.version,updated_at=excluded.updated_at`)
      .run(
        next.botId,
        next.conversationId,
        JSON.stringify({
          goal: next.goal,
          items: next.items,
          source: next.source,
        }),
        next.version,
        next.updatedAt,
      );
    return next;
  }

  private todoSource(scope: ExecutionScope, actor: NonNullable<TodoPlan["source"]>) {
    const source = TodoSourceSchema.parse(actor);
    const rows = this.db
      .prepare(`SELECT t.id FROM tool_calls t JOIN messages m ON m.id=t.message_id
        JOIN runs r ON r.id=m.run_id AND r.bot_id=m.bot_id AND r.conversation_id=m.conversation_id
        WHERE m.id=? AND m.run_id=? AND m.bot_id=? AND m.conversation_id=?
        AND m.role='assistant' AND t.tool_call_id=? AND t.tool='todo_update'
        AND t.status='running' AND r.status='running' LIMIT 2`)
      .all(source.messageId, source.runId, scope.botId, scope.conversationId, source.toolCallId);
    return rows.length === 1 ? source : null;
  }

  /** actor is a trusted dispatch receipt, separate from user/model-editable plan arguments. */
  setTodo(
    scope: ExecutionScope,
    input: TodoUpdate,
    actor?: NonNullable<TodoPlan["source"]>,
  ): TodoPlan {
    const change = TodoUpdateSchema.parse(input);
    return transaction(this.db, () => {
      const { plan: previous, legacySource } = this.readTodo(scope);
      if (previous.version !== change.expectedVersion) throw new ExecutionConflictError();
      const source =
        previous.source ?? (!legacySource && actor ? this.todoSource(scope, actor) : null);
      // Legacy/unverifiable first updates must stay unknown, rather than attaching a later reply.
      const unknownSource = legacySource || (!!actor && !source);
      const next = TodoPlanSchema.parse({
        ...previous,
        goal: change.goal,
        items: change.items,
        source,
        version: previous.version + 1,
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare(
          `INSERT INTO execution_todo (bot_id, conversation_id, plan_json, version, updated_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_id, conversation_id) DO UPDATE SET
           plan_json=excluded.plan_json, version=excluded.version, updated_at=excluded.updated_at`,
        )
        .run(
          next.botId,
          next.conversationId,
          JSON.stringify({
            goal: next.goal,
            items: next.items,
            ...(!unknownSource ? { source: next.source } : {}),
          }),
          next.version,
          next.updatedAt,
        );
      return next;
    });
  }
}
