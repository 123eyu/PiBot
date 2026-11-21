import type { ChatReplies, ChatRun, ImageRunHost } from "@pibot/brain/kit";
import { MessageSchema } from "@pibot/images-contract/full";
import { MessagesRepo, RunsRepo, transaction } from "@pibot/storage";
import type { ImageAuthorization } from "../artifacts/image-service.ts";

export function retainGeneratedImage(
  deps: ImageRunHost,
  run: ChatRun,
  replies: ChatReplies,
  language: "zh" | "en",
  authorization: ImageAuthorization | undefined,
  emit: (action: () => void) => void,
  stopped?: "budget_exhausted" | "aborted",
) {
  const messages = new MessagesRepo(deps.db);
  const route = {
    botId: run.botId,
    conversationId: run.conversationId,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
  };
  // Generation succeeded independently. A later publication failure cannot erase that fact.
  const message = messages.get(run.messageId);
  const savedUsage =
    message?.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
      ? message.usage
      : {};
  const retainedUsage = MessageSchema.shape.usage.parse({
    ...savedUsage,
    imageGeneration: true,
    imageArtifactSourceRunId: run.runId,
    generationFinalization: "incomplete",
    stopReason: stopped ?? "stop",
  });
  const notice =
    language === "zh"
      ? "生成图片已保留；任务结果发布未完成，请核实。"
      : "Generated image retained; task result publication is incomplete and needs verification.";
  replies.content = [message?.content, notice].filter(Boolean).join("\n\n");
  const updates = transaction(deps.db, () => {
    messages.update(run.messageId, { content: replies.content });
    const status = stopped === "aborted" ? "aborted" : stopped ? "error" : "done";
    const updates = replies.finish(status, retainedUsage, stopped);
    new RunsRepo(deps.db).finish(
      run.runId,
      status,
      stopped === "aborted" ? "aborted" : stopped ? "error" : "stop",
      stopped,
    );
    authorization?.finish(status);
    deps.local?.approvals.audit.append({
      botId: run.botId,
      runId: run.runId,
      kind: "image.finished",
      summary: "Generated image retained / 已保留生成图片",
      detail: { reasonCode: stopped ?? "publication_incomplete", actor: "automatic" },
    });
    return updates;
  });
  if (stopped) deps.logger.warn(`Generated image retained after stop run=${run.runId}`);
  else deps.logger.error(`Committed image finalization incomplete run=${run.runId}`);
  emit(() => replies.publishUpdates(updates));
  if (stopped)
    emit(() =>
      deps.peer.emit("chat.error", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        code: stopped,
        message: stopped,
      }),
    );
  else
    emit(() =>
      deps.peer.emit("chat.done", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        usage: retainedUsage,
        stopReason: "stop",
      }),
    );
}
