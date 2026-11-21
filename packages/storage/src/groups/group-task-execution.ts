import type { DatabaseSync } from "node:sqlite";
import { type KernelMethodParams, type KernelMethodResults, RpcError } from "@pibot/protocol-base";
import { ConversationsRepo } from "../conversations/conversations.ts";
import { CheckpointRepo } from "../execution/execution-checkpoint.ts";
import { TaskRepo } from "../execution/task-execution.ts";

/** Task ancestry is persisted authority, not a renderer-provided Bot/conversation guess. */
export class GroupTaskExecutionRepo {
  constructor(private readonly db: DatabaseSync) {}
  groupPage(
    params: KernelMethodParams["groups.execution.tasks"],
  ): KernelMethodResults["groups.execution.tasks"] {
    const topic = new ConversationsRepo(this.db).forGroup(params.groupId);
    if (!topic) throw new RpcError(-32602, "group_unavailable");
    const topicId = topic.id;
    const belongs = `deleted_at IS NULL AND archived_at IS NULL
      AND json_extract(authority_json,'$.source.groupId')=?
      AND EXISTS(SELECT 1 FROM conversations source WHERE source.id=task_instances.source_conversation_id
        AND source.kind IN ('group','thread') AND source.group_id=? AND (source.id=? OR source.thread_of=?))`;
    const cursor = params.before
      ? this.db
          .prepare(`SELECT created_at FROM task_instances WHERE id=? AND ${belongs}`)
          .get(params.before, params.groupId, params.groupId, topicId, topicId)
      : undefined;
    if (params.before && !cursor) throw new RpcError(-32602, "group_task_cursor_unavailable");
    const limit = params.limit ?? 25;
    const rows = this.db
      .prepare(`SELECT id,json_extract(authority_json,'$.source.taskId') AS groupTaskId
      FROM task_instances WHERE ${belongs} AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
      ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(
        params.groupId,
        params.groupId,
        topicId,
        topicId,
        params.before ?? null,
        cursor?.created_at ?? "",
        cursor?.created_at ?? "",
        params.before ?? "",
        limit + 1,
      );
    const tasks = new TaskRepo(this.db);
    const items = rows.slice(0, limit).flatMap((row) => {
      const task = tasks.get(String(row.id));
      if (!task) return [];
      const assignment = this.db
        .prepare(`SELECT t.id,t.title FROM group_tasks t JOIN conversations thread
        ON thread.id=t.thread_conversation_id AND thread.thread_of=? AND thread.group_id=t.group_id
        WHERE t.group_id=? AND t.assignee_bot_id=? AND (t.id=? OR t.thread_conversation_id=?)
        ORDER BY (t.id=?) DESC LIMIT 1`)
        .get(
          topicId,
          params.groupId,
          task.botId,
          row.groupTaskId ?? null,
          task.conversationId,
          row.groupTaskId ?? null,
        );
      return [
        {
          ...task,
          groupTaskId: assignment ? String(assignment.id) : null,
          groupTaskTitle: assignment ? String(assignment.title) : null,
        },
      ];
    });
    return { items, nextBefore: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }
  page(
    params: KernelMethodParams["groups.tasks.execution"],
  ): KernelMethodResults["groups.tasks.execution"] {
    const owner = this.db
      .prepare(`SELECT t.assignee_bot_id AS botId,t.thread_conversation_id AS threadId,
      c.thread_of AS topicId FROM group_tasks t JOIN conversations c ON c.id=t.thread_conversation_id
      JOIN groups g ON g.id=t.group_id AND c.thread_of=(SELECT id FROM conversations WHERE group_id=g.id AND kind='group' ORDER BY archived_at IS NULL DESC,updated_at DESC,id DESC LIMIT 1)
      WHERE t.id=? AND t.group_id=? AND c.group_id=t.group_id`)
      .get(params.taskId, params.groupId);
    if (!owner) throw new RpcError(-32602, "group_task_unavailable");
    const matches = `bot_id=? AND deleted_at IS NULL AND archived_at IS NULL
      AND json_extract(authority_json,'$.source.groupId')=?
      AND EXISTS(SELECT 1 FROM conversations origin WHERE origin.id=task_instances.source_conversation_id
        AND origin.kind IN ('group','thread') AND origin.group_id=? AND (origin.id=? OR origin.thread_of=?))
      AND (json_extract(authority_json,'$.source.taskId')=?
        OR (source_conversation_id=? AND EXISTS(SELECT 1 FROM conversations source
          WHERE source.id=source_conversation_id AND source.kind='thread' AND source.group_id=? AND source.thread_of=?)))`;
    const values = [
      String(owner.botId),
      params.groupId,
      params.groupId,
      String(owner.topicId),
      String(owner.topicId),
      params.taskId,
      String(owner.threadId),
      params.groupId,
      String(owner.topicId),
    ];
    const cursor = params.before
      ? this.db
          .prepare(`SELECT created_at FROM task_instances WHERE id=? AND ${matches}`)
          .get(params.before, ...values)
      : undefined;
    if (params.before && !cursor) throw new RpcError(-32602, "group_task_cursor_unavailable");
    const limit = params.limit ?? 25;
    const rows = this.db
      .prepare(`SELECT id FROM task_instances WHERE ${matches}
      AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
      ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(
        ...values,
        params.before ?? null,
        cursor?.created_at ?? "",
        cursor?.created_at ?? "",
        params.before ?? "",
        limit + 1,
      );
    const repo = new TaskRepo(this.db);
    const items = rows.slice(0, limit).flatMap((row) => {
      const task = repo.get(String(row.id));
      return task ? [task] : [];
    });
    const run = this.db
      .prepare(`SELECT id FROM runs WHERE task_id=? AND group_id=? AND bot_id=?
      ORDER BY (status='running') DESC,(status='queued') DESC,created_at DESC,id DESC LIMIT 1`)
      .get(params.taskId, params.groupId, String(owner.botId));
    const result = this.db
      .prepare(`SELECT m.id,m.conversation_id FROM group_task_results result
      JOIN messages m ON m.id=result.message_id JOIN conversations c ON c.id=m.conversation_id
      WHERE result.task_id=? AND c.group_id=? AND c.id=?`)
      .get(params.taskId, params.groupId, String(owner.topicId));
    return {
      items,
      nextBefore: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
      checkpoint: run ? (new CheckpointRepo(this.db).get(String(run.id)) ?? null) : null,
      resultMessageId: result ? String(result.id) : null,
    };
  }
}
