import { randomUUID } from "node:crypto";
import { mapAgentError } from "@pibot/agent";
import type { ChatRun, ImageRunHost, ToolRunContext } from "@pibot/brain/kit";
import { ChatReplies } from "@pibot/brain/kit";
import { ImageDeliverySchema } from "@pibot/images-contract/full";
import { MessagesRepo, RunsRepo, transaction } from "@pibot/storage";
import type { ImageArtifactService } from "../artifacts/image-artifact-service.ts";
import { imageDeliveryText } from "./image-delivery-text.ts";

/** Save/re-send runs acquire the same queue slot but never open a session or image provider. */
export async function reuseImageRun(
  deps: ImageRunHost,
  run: ChatRun,
  artifacts: ImageArtifactService,
) {
  const route = {
    botId: run.botId,
    conversationId: run.conversationId,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
  };
  const context: ToolRunContext = {
    ...route,
    runId: run.runId,
    messageId: run.messageId,
    taskId: run.taskId,
    cycleId: run.cycleId,
    signal: run.signal,
    language: deps.language(),
  };
  const replies = new ChatReplies(deps.db, run, deps.peer, deps.redactor, () => {});
  const tools = deps.local?.run(context);
  const emit = (notify: () => void) => {
    try {
      notify();
    } catch {
      deps.logger.warn("Image reuse notification deferred; history retained");
    }
  };
  try {
    if (!tools || !run.imageOperation) throw new Error("Image reuse unavailable");
    const call = { id: randomUUID(), tool: "image_result", input: { ...run.imageOperation } };
    const allowed = await tools.ports.authorize(call, run.signal);
    const result = allowed.allow
      ? await tools.ports.execute(call, run.signal, () => {})
      : { text: allowed.reason ?? "Image reuse denied / 图片复用被拒绝", isError: true };

    run.signal.throwIfAborted();
    const source =
      allowed.allow && !result.isError
        ? artifacts.repo.get(run.imageOperation.sourceRunId)
        : undefined;
    const original = source && new MessagesRepo(deps.db).get(source.target.source.messageId);
    const value = original?.usage;
    const delivery = ImageDeliverySchema.safeParse(
      value && typeof value === "object" && !Array.isArray(value) ? value.imageDelivery : undefined,
    );
    replies.content = deps.redactor.redact(
      result.isError
        ? result.text
        : `${context.language === "zh" ? (run.imageOperation.action === "resend" ? "已重发原图片附件。" : "已读取原图片交付结果。") : run.imageOperation.action === "resend" ? "Original image attachment shared." : "Original image delivery inspected."}\n${imageDeliveryText(context.language, delivery.success ? delivery.data : undefined)}`,
    );
    const usage = {
      imageSourceRunId: run.imageOperation.sourceRunId,
      imageOperation: run.imageOperation.action,
      ...(delivery.success ? { imageDelivery: delivery.data } : {}),
      stopReason: "stop",
    };
    const updates = transaction(deps.db, () => {
      const updates = replies.finish("done", usage);
      new RunsRepo(deps.db).finish(run.runId, "done", "stop");
      return updates;
    });
    emit(() => replies.publishUpdates(updates));
    emit(() =>
      deps.peer.emit("chat.delta", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        text: replies.content,
      }),
    );
    emit(() =>
      deps.peer.emit("chat.done", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        usage,
        stopReason: "stop",
      }),
    );
  } catch (error) {
    const code = run.signal.aborted ? "aborted" : mapAgentError(error);
    run.stopCause ??= { code: "error" };
    run.controller.abort(run.stopCause);
    const updates = transaction(deps.db, () => {
      const status = code === "aborted" ? "aborted" : "error";
      // Same shape as image-run: the reason lives in error_code, which history and settle read.
      new RunsRepo(deps.db).finish(run.runId, status, status, code);
      return replies.finish(code === "aborted" ? "aborted" : "error", { stopReason: code }, code);
    });
    emit(() => replies.publishUpdates(updates));
    emit(() =>
      deps.peer.emit("chat.error", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        code,
        message: code,
      }),
    );
  } finally {
    try {
      tools?.finish();
      replies.interruptAdditions();
    } finally {
      run.stopCause ??= { code: "completed" };
      run.controller.abort(run.stopCause);
      deps.finished(run);
    }
  }
}
