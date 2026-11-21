import type { DatabaseSync } from "node:sqlite";
import type { ToolRunContext } from "@pibot/brain/orchestration-kit";
import { visibleGroupMessage } from "@pibot/brain/orchestration-kit";
import { type Group, type Message, RpcError } from "@pibot/protocol-base";
import { GroupTasksRepo, ImageArtifactsRepo, MessagesRepo, RunsRepo } from "@pibot/storage";

export interface GroupImageReference {
  message: Message;
  priority: boolean;
}

// Rebuild ownership from the database on every load; snapshots are never authorization grants.
export function groupImageReferences(db: DatabaseSync, context: ToolRunContext, group: Group) {
  const runs = new RunsRepo(db),
    messages = new MessagesRepo(db);
  const current = runs.get(context.runId);
  if (
    !current ||
    current.groupId !== group.id ||
    current.botId !== context.botId ||
    current.conversationId !== context.conversationId ||
    current.messageId !== context.messageId ||
    (current.status !== "running" && current.status !== "queued") ||
    !group.members.some((m) => m.botId === context.botId)
  )
    throw new RpcError(-32602, "Group context owner unavailable");
  const references = new Map<string, GroupImageReference>();
  const add = (message: Message | undefined, priority: boolean) => {
    if (!message || !visibleGroupMessage(db, group, message)) return;
    references.set(message.id, {
      message,
      priority: priority || references.get(message.id)?.priority === true,
    });
  };
  if (current.userMessageId) add(messages.get(current.userMessageId), true);
  // Completion wakes carry their finished run identity even after the display leaves the latest page.
  for (const id of new Set([current.parentRunId, current.afterRunId])) {
    if (!id) continue;
    const run = runs.get(id);
    if (
      !run ||
      run.groupId !== group.id ||
      (run.status !== "done" && !new ImageArtifactsRepo(db).get(run.id)?.generatedAt) ||
      !group.members.some((m) => m.botId === run.botId)
    )
      continue;
    const result = messages.get(run.messageId);
    if (result?.runId !== run.id || result.botId !== run.botId) continue;
    if (run.taskId) {
      const task = new GroupTasksRepo(db, (text) => text).get(run.taskId);
      if (
        !task ||
        task.groupId !== group.id ||
        task.status === "cancelled" ||
        task.assigneeBotId !== run.botId
      )
        continue;
    }
    add(result, true);
  }
  for (const sourceRunId of [...(context.imageResultSources ?? [])].slice(-5)) {
    try {
      const source = new ImageArtifactsRepo(db).resolveSource(sourceRunId, {
        botId: context.botId,
        conversationId: current.conversationId,
        groupId: group.id,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        runId: current.id,
      });
      add(messages.get(source.artifact.target.source.messageId), true);
    } catch (error) {
      if (!(error instanceof TypeError && error.message.startsWith("image_artifact_"))) throw error;
      // Deleted/reassigned source is no longer a grant, even if its earlier tool result remains in JSONL.
    }
  }
  for (const message of messages.list(group.conversationId, { limit: 30 })) add(message, false);
  return [...references.values()];
}
