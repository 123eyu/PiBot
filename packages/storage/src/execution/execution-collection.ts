import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ArchivedPlanSchema,
  type ExecutionCollectionChange,
  type ExecutionScope,
  TodoPlanSchema,
} from "@pibot/protocol-base";
import { readPage } from "../database/paging.ts";
import { ExecutionConflictError, ExecutionRepo } from "./execution.ts";
import { TaskConflictError, TaskRepo } from "./task-execution.ts";

/** The service holds a transaction covering visibility, current plan and its audit receipt. */
export class ExecutionCollectionRepo {
  constructor(private readonly db: DatabaseSync) {}

  plans(scope: ExecutionScope, page: { before?: string; limit?: number }) {
    const limit = Math.min(50, Math.max(1, page.limit ?? 25));
    const scopeFilters = [
      ["bot_id", scope.botId],
      ["conversation_id", scope.conversationId],
    ] as const;
    const rows = readPage(
      this.db,
      "execution_plan_archive",
      "*",
      "archived_at",
      { before: page.before, limit: limit + 1 },
      [...scopeFilters, ["deleted_at", null]],
      [...scopeFilters],
    );
    const items = rows.slice(0, limit).map((row) =>
      ArchivedPlanSchema.parse({
        ...JSON.parse(String(row.plan_json)),
        ...scope,
        id: row.id,
        archivedAt: row.archived_at,
      }),
    );
    return { items, nextBefore: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  plan(change: ExecutionCollectionChange) {
    const scope = { botId: change.botId, conversationId: change.conversationId };
    const repo = new ExecutionRepo(this.db),
      current = repo.todo(scope);
    if (change.id) {
      const row = this.db
        .prepare(`SELECT plan_json FROM execution_plan_archive
        WHERE id=? AND bot_id=? AND conversation_id=? AND deleted_at IS NULL`)
        .get(change.id, change.botId, change.conversationId);
      if (!row) throw new ExecutionConflictError();
      const snapshot = TodoPlanSchema.parse(JSON.parse(String(row.plan_json)));
      if (snapshot.version !== change.expectedVersion) throw new ExecutionConflictError();
      if (change.action === "archive") throw new ExecutionConflictError();
      // Restoring must not silently replace a newer plan; clearing it is an explicit user action.
      if (change.action === "restore" && (current.items.length || current.goal))
        throw new ExecutionConflictError();
      this.db
        .prepare("UPDATE execution_plan_archive SET deleted_at=? WHERE id=?")
        .run(new Date().toISOString(), change.id);
      return change.action === "restore"
        ? repo.replaceTodoSnapshot(scope, current.version, snapshot)
        : undefined;
    }
    if (change.action === "restore" || current.version !== change.expectedVersion)
      throw new ExecutionConflictError();
    if (!current.items.length && !current.goal) throw new ExecutionConflictError();
    // Deletion hides the snapshot too; the originating messages and audit are never erased.
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO execution_plan_archive
      (id,bot_id,conversation_id,plan_json,archived_at,deleted_at) VALUES(?,?,?,?,?,?)`)
      .run(
        randomUUID(),
        change.botId,
        change.conversationId,
        JSON.stringify(current),
        now,
        change.action === "delete" ? now : null,
      );
    return repo.replaceTodoSnapshot(scope, current.version, { goal: "", items: [], source: null });
  }

  tasks(change: ExecutionCollectionChange) {
    const repo = new TaskRepo(this.db),
      root = change.id ? repo.get(change.id) : undefined;
    if (
      !root ||
      root.botId !== change.botId ||
      root.conversationId !== change.conversationId ||
      root.deletedAt ||
      root.version !== change.expectedVersion
    )
      throw new TaskConflictError();
    if ((change.action === "restore") !== !!root.archivedAt && change.action !== "delete")
      throw new TaskConflictError();
    const rows = this.db
      .prepare(`WITH RECURSIVE tree(id) AS
      (SELECT ? UNION SELECT t.id FROM task_instances t JOIN tree p ON t.parent_task_id=p.id)
      SELECT t.id,t.archive_batch_id AS archiveBatch FROM task_instances t JOIN tree ON tree.id=t.id LIMIT 1001`)
      .all(root.id);
    if (rows.length > 1000) throw new TaskConflictError();
    const priorBatch = rows.find((row) => row.id === root.id)?.archiveBatch;
    if (change.action === "restore" && !priorBatch) throw new TaskConflictError();
    const batch = randomUUID();
    const now = new Date().toISOString(),
      changed = [];
    for (const row of rows) {
      const task = repo.get(String(row.id));
      if (
        !task ||
        task.botId !== root.botId ||
        task.conversationId !== root.conversationId ||
        ["queued", "running", "stopping"].includes(task.status)
      )
        throw new TaskConflictError();
      if (
        task.deletedAt ||
        (change.action === "archive" && task.archivedAt) ||
        (change.action === "restore" && row.archiveBatch !== priorBatch)
      )
        continue;
      this.db
        .prepare(`UPDATE task_instances SET archived_at=?,deleted_at=?,archive_batch_id=?,
        version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(
          change.action === "archive"
            ? now
            : change.action === "restore"
              ? null
              : (task.archivedAt ?? null),
          change.action === "delete" ? now : null,
          change.action === "archive"
            ? batch
            : change.action === "restore"
              ? null
              : (row.archiveBatch ?? null),
          now,
          task.id,
          task.version,
        );
      const next = repo.get(task.id);
      if (next) changed.push(next);
    }
    return changed;
  }
}
