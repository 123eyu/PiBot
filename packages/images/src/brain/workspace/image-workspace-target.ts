import { randomUUID } from "node:crypto";
import type { LocalToolCall } from "@pibot/agent";
import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import { activeGroup, prepareTool } from "@pibot/brain/kit";
import { ExecError, imageExportFileName } from "@pibot/execution";
import {
  BotsRepo,
  ConversationsRepo,
  GroupTasksRepo,
  type ImageArtifactTarget,
  MessagesRepo,
  RunsRepo,
} from "@pibot/storage";

/** Only the persisted private artifact intent may supply an output destination. */
export type ImageWorkspaceTarget = ImageArtifactTarget;

export function assertImageSaveOwner(local: LocalService, context: ToolRunContext) {
  context.signal.throwIfAborted();
  if (!local.execution.allows(context, "write_file")) throw new ExecError("outside_workplace");
  const run = new RunsRepo(local.deps.db).get(context.runId);
  const message = new MessagesRepo(local.deps.db).get(context.messageId);
  const bot = new BotsRepo(local.deps.db).get(context.botId);
  if (
    !bot ||
    bot.archivedAt ||
    run?.status !== "running" ||
    run.botId !== context.botId ||
    run.messageId !== context.messageId ||
    run.conversationId !== context.conversationId ||
    run.groupId !== (context.groupId ?? null) ||
    run.taskId !== (context.taskId ?? null) ||
    run.cycleId !== (context.cycleId ?? null) ||
    message?.role !== "assistant" ||
    message.status !== "streaming" ||
    message.botId !== context.botId ||
    message.runId !== context.runId ||
    message.conversationId !== context.conversationId
  )
    throw new ExecError("outside_workplace");
  if (context.groupId) {
    activeGroup(local.deps.db, context.groupId, context.botId, context.conversationId);
    const conversation = new ConversationsRepo(local.deps.db).get(context.conversationId ?? "");
    if ((conversation?.kind === "thread" ? conversation.id : undefined) !== context.threadId)
      throw new ExecError("outside_workplace");
    if (context.taskId) {
      const task = new GroupTasksRepo(local.deps.db, (value) => value).get(context.taskId);
      if (
        task?.groupId !== context.groupId ||
        task.assigneeBotId !== context.botId ||
        task.threadConversationId !== context.conversationId
      )
        throw new ExecError("outside_workplace");
    }
  } else {
    const conversation = new ConversationsRepo(local.deps.db).get(context.conversationId ?? "");
    if (
      conversation?.kind !== "dm" ||
      conversation.botId !== context.botId ||
      conversation.archivedAt
    )
      throw new ExecError("outside_workplace");
  }
  if (context.routineRunId) local.unattendedAuthorization.record(context);
}

export function imageSaveCall(fileName: string): LocalToolCall {
  // Reuse the text tool's path/policy adapter only. Its empty content is never executed or persisted.
  return { id: randomUUID(), tool: "write_file", input: { path: fileName, content: "" } };
}

export async function prepareImageWorkspace(local: LocalService, context: ToolRunContext) {
  context = {
    ...context,
    signal: AbortSignal.any([context.signal, local.shutdown.signal, AbortSignal.timeout(20_000)]),
  };
  assertImageSaveOwner(local, context);
  if (new BotsRepo(local.deps.db).get(context.botId)?.category !== "image")
    throw new ExecError("invalid_input");
  const fileName = imageExportFileName({
    runId: context.runId,
    attachmentId: context.runId,
    extension: "png",
  });
  const prepared = await prepareTool(local, context, imageSaveCall(fileName), context.signal);
  assertImageSaveOwner(local, context);
  if (!prepared.boundary) throw new ExecError("outside_workplace");
  const {
    botId,
    runId,
    messageId,
    conversationId,
    groupId,
    threadId,
    taskId,
    cycleId,
    routineRunId,
    routineSource,
    routineWorkplace,
    language,
  } = context;
  return structuredClone({
    source: {
      botId,
      runId,
      messageId,
      conversationId: conversationId as string,
      groupId,
      threadId,
      taskId,
      cycleId,
      routineRunId,
      routineSource,
      routineWorkplace,
      language,
    },
    cwd: prepared.cwd,
    boundary: prepared.boundary,
  }) satisfies ImageWorkspaceTarget;
}
