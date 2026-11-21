import type { DatabaseSync } from "node:sqlite";
import { type KernelMethodParams, type KernelMethodResults, RpcError } from "@pibot/protocol-base";
import { ConversationsRepo } from "../conversations/conversations.ts";
import { MessagesRepo } from "../workspace/repositories.ts";

/** Include direct user-task runs in the main topic without exposing unrelated member replies. */
export class GroupTaskHistoryRepo {
  constructor(private readonly db: DatabaseSync) {}
  page(
    params: KernelMethodParams["groups.tasks.history"],
  ): KernelMethodResults["groups.tasks.history"] {
    const topic = new ConversationsRepo(this.db).forGroup(params.groupId);
    const task = this.db
      .prepare(`SELECT t.thread_conversation_id AS threadId FROM group_tasks t
      JOIN conversations c ON c.id=t.thread_conversation_id AND c.group_id=t.group_id
      WHERE t.id=? AND t.group_id=? AND c.thread_of=?`)
      .get(params.taskId, params.groupId, topic?.id ?? "");
    if (!task || !topic) throw new RpcError(-32602, "group_task_unavailable");
    const matches = `EXISTS(SELECT 1 FROM conversations c WHERE c.id=messages.conversation_id AND c.group_id=?)
      AND (conversation_id=? OR EXISTS(SELECT 1 FROM runs r WHERE r.id=messages.run_id AND r.task_id=? AND r.group_id=?)
        OR id IN(SELECT message_id FROM group_task_sources WHERE task_id=? AND conversation_id=?))`;
    const values = [
      params.groupId,
      String(task.threadId),
      params.taskId,
      params.groupId,
      params.taskId,
      topic.id,
    ];
    const cursor = params.before
      ? this.db
          .prepare(`SELECT created_at FROM messages WHERE id=? AND ${matches}`)
          .get(params.before, ...values)
      : undefined;
    if (params.before && !cursor) throw new RpcError(-32602, "group_task_cursor_unavailable");
    const limit = params.limit ?? 25;
    const rows = this.db
      .prepare(`SELECT id FROM messages WHERE ${matches} AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
      ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(
        ...values,
        params.before ?? null,
        cursor?.created_at ?? "",
        cursor?.created_at ?? "",
        params.before ?? "",
        limit + 1,
      );
    const messages = new MessagesRepo(this.db);
    const items = rows.slice(0, limit).flatMap((row) => {
      const message = messages.get(String(row.id));
      return message ? [message] : [];
    });
    const oldest = rows[limit - 1];
    return {
      messages: items.reverse(),
      nextBefore: rows.length > limit && oldest ? String(oldest.id) : null,
    };
  }
}
