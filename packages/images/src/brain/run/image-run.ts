import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentError, mapAgentError } from "@pibot/agent";
import type { ChatRun, ImageRunHost, ToolRunContext } from "@pibot/brain/kit";
import {
  AttachmentService,
  auditText,
  ChatReplies,
  type PreparedAttachments,
  resolveRunWorkplace,
  topicWorkplaceSnapshot,
} from "@pibot/brain/kit";
import { imageExportFileName } from "@pibot/execution";
import {
  type Bot,
  type ImageContent,
  type ImageDelivery,
  ImageDeliverySchema,
  type ImageMode,
  type Message,
  MessageSchema,
} from "@pibot/images-contract/full";
import { AttachmentsRepo, MessagesRepo, RunsRepo, transaction } from "@pibot/storage";
import type { ImageArtifactService } from "../artifacts/image-artifact-service.ts";
import { ImageAuthorization } from "../artifacts/image-service.ts";
import { prepareImageWorkspace } from "../workspace/image-workspace-target.ts";
import { imageContextInputs } from "./image-context-input.ts";
import { imageDeliveryText } from "./image-delivery-text.ts";
import { imageQualityPrompt } from "./image-quality-prompt.ts";
import { imageUsage, observedImageUsage, validatedImages } from "./image-run-output.ts";
import { retainGeneratedImage } from "./image-run-retained.ts";

/**
 * Cap on one paid request. Past generations took 40–130 s; the owner hit the cap once on
 * 2026-10-23 with gpt-image-2. Probes shorten it through `imageGenerationTimeoutMs`.
 */
export const IMAGE_GENERATION_TIMEOUT_MS = 300_000;

/** The run queue owns the Bot lock until both HTTP and attachment work have settled. */
export async function generateImageRun(
  deps: ImageRunHost,
  run: ChatRun,
  text: string,
  _sessionFile: string | null,
  bot: Bot,
  images: ImageContent[],
  artifacts: ImageArtifactService,
) {
  const local = deps.local;
  let mode: ImageMode = images.length ? "image-to-image" : "text-to-image";
  const route = {
    botId: run.botId,
    conversationId: run.conversationId,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
  };
  const signal = local ? AbortSignal.any([run.signal, local.shutdown.signal]) : run.signal;
  const context: ToolRunContext = {
    ...route,
    runId: run.runId,
    messageId: run.messageId,
    cycleId: run.cycleId,
    taskId: run.taskId,
    signal,
    language: deps.language(),
    ...(run.routine
      ? {
          routineRunId: run.routine.id,
          routineSource: run.routine.source,
          routineName: run.routine.name,
          routineClock: run.routine.clock,
          routineApprovalWaitMs: run.routine.approvalWaitMs,
          routineWorkplace: run.routine.workplace,
        }
      : {}),
  };
  const replies = new ChatReplies(deps.db, run, deps.peer, deps.redactor, () => {});
  const runs = new RunsRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  let batch: PreparedAttachments | undefined;
  let committed = false;
  let startedAt = 0;
  let authorization: ImageAuthorization | undefined;
  let deadline: AbortSignal | undefined;
  const emit = (action: () => void) => {
    try {
      action();
    } catch {
      deps.logger.warn("Image notification deferred; history retains committed metadata");
    }
  };
  // The run activity line, reused: an image run's only long wait is its one paid request.
  // Task runs have no visible reply, as in chat-run.
  const activity = (phase: "executing_tool" | "clear") => {
    if (run.executionTaskId) return;
    emit(() =>
      deps.peer.emit("chat.activity", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        ...(phase === "clear" ? { phase } : { phase, tool: "image_generation" }),
      }),
    );
  };
  // A stop is the user's (or quit/budget); the cap firing alone is a service that never answered.
  const stopCode = (error: unknown) => {
    if (local?.budgets.repo.get(run.budgetRootRunId ?? run.runId)?.exhaustedReason)
      return "budget_exhausted" as const;
    if (run.aborted || signal.aborted) return "aborted" as const;
    const mapped = mapAgentError(error);
    return mapped === "image_timeout" || (mapped === "aborted" && deadline?.aborted)
      ? ("image_timeout" as const)
      : mapped;
  };
  const metadata = {
    toolName: "image_generation",
    category: "web" as const,
    providerId: auditText(bot.modelProvider ?? "", deps.redactor),
    modelId: auditText(bot.modelId ?? "", deps.redactor),
    imageMode: mode,
    source: run.routine?.source ?? ("chat" as const),
    ...(run.routine ? { routineRunId: run.routine.id } : {}),
  };
  try {
    signal.throwIfAborted();
    if (!local || !deps.agent.generateImage) throw new AgentError("image_unsupported");
    local.budgets.begin(
      context,
      local.execution.get({ botId: bot.id, conversationId: run.conversationId }).limits,
    );
    if (run.routine?.resumeDecision || run.parking) throw new AgentError("image_unsupported");
    if (images.length) validatedImages(images);
    context.topicWorkplace = topicWorkplaceSnapshot(local, context);
    const place = await resolveRunWorkplace(local, context, signal);
    context.runWorkplace = { cwd: place.cwd, boundary: place.boundary };
    // Image generation bypasses LocalRun, but exporting its file still needs the original
    // workspace context when the queue captures checkpoints before releasing this run.
    local.retainRunContext(context);
    const references = await imageContextInputs(local, context, images);
    images = references.images;
    mode = images.length ? "image-to-image" : "text-to-image";
    metadata.imageMode = mode;
    authorization = new ImageAuthorization(local, deps.agent, bot, context, mode);
    const model = await authorization.authorize();
    metadata.modelId = auditText(model.id, deps.redactor);
    const target = await prepareImageWorkspace(local, context);
    artifacts.repo.capture(target, {
      provider: model.provider,
      id: model.id,
      recipient: model.recipient,
      mode,
    });
    authorization.assertCurrent();
    references.assertCurrent();
    startedAt = Date.now();
    local.approvals.audit.append({
      botId: bot.id,
      runId: run.runId,
      kind: "image.started",
      summary: "Image generation started / 开始生成图片",
      detail: { ...metadata, target: model?.recipient, imageCount: images.length },
    });
    // The queue already reported this run as running.
    // A timeout aborts the real request. No race releases the run while it is still active.
    const timeoutMs = Math.min(
      local.deps.imageGenerationTimeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS,
      IMAGE_GENERATION_TIMEOUT_MS,
    );
    deadline = AbortSignal.timeout(timeoutMs);
    const generationSignal = AbortSignal.any([signal, deadline]);
    const prompt = imageQualityPrompt(
      deps.redactor.redact(text),
      deps.language(),
      bot.norms ? deps.redactor.redact(bot.norms) : undefined,
    );
    const accounting = local.budgets.observer(context);
    const requestId = randomUUID();
    accounting.beforeRequest({
      id: requestId,
      kind: "response",
      provider: model.provider,
      model: model.id,
      pricingKnown: false,
    });
    let requestSettled = false;
    let outcome = "done";
    const requestStartedAt = Date.now();
    const endExec = authorization.timing.enter("exec");
    activity("executing_tool");
    const result = await deps.agent
      .generateImage({
        model: { provider: model.provider, id: model.id },
        recipient: model?.recipient as string,
        mode: mode,
        prompt: prompt.text,
        images,
        signal: generationSignal,
        timeoutMs,
      })
      .then((value) => {
        requestSettled = true;
        accounting.settled({
          id: requestId,
          complete: true,
          usage: observedImageUsage(value.usage),
        });
        return value;
      })
      .catch((error: unknown) => {
        outcome = stopCode(error);
        throw error;
      })
      .finally(() => {
        endExec();
        if (!requestSettled) accounting.settled({ id: requestId, complete: false });
        activity("clear");
        // One line per paid request, lengths only (never prompt text), to compare services and
        // whether the norms/brief sections change generation time.
        const lengths = prompt.lengths;
        deps.logger.info(
          `image.generation run=${run.runId} provider=${metadata.providerId} model=${metadata.modelId} mode=${mode} promptChars=${lengths.promptChars} requestChars=${lengths.requestChars} normsChars=${lengths.normsChars} briefChars=${lengths.briefChars} referenceImages=${images.length} durationMs=${Date.now() - requestStartedAt} timeoutMs=${timeoutMs} outcome=${outcome}`,
        );
      });
    const endPost = authorization.timing.enter("post");
    const outputs = validatedImages(result.images);
    const attachments = new AttachmentService(deps.db, deps.dataDir, local.deps.host.attachments);
    batch = await attachments.prepareOutput(
      bot.id,
      outputs.map(({ bytes, image }, index) => ({
        name: `image-${index + 1}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]}`,
        bytes,
      })),
      // A paid response that already arrived is retained in managed storage even if its budget
      // stops further work. This grants no permission to export into the project directory.
      AbortSignal.any([local.shutdown.signal, AbortSignal.timeout(20_000)]),
    );
    let finalText = deps.redactor.redact(
      result.text?.trim() || (context.language === "zh" ? "图片已生成。" : "Image generated."),
    );
    let usage = MessageSchema.shape.usage.parse({
      ...imageUsage(result.usage),
      imageGeneration: true,
      imageMode: mode,
      imageCount: batch.items.length,
      stopReason: "stop",
      ...(run.routine ? { finalReply: finalText } : {}),
      ...(run.threadId
        ? { taskReply: finalText.slice(0, 100_000).replace(/[\uD800-\uDBFF]$/u, "") }
        : {}),
    });
    // Paid generation and managed delivery commit before the independent workspace operation.
    transaction(deps.db, () => {
      // Retention completes an already-authorized request. It cannot authorize another request,
      // a project write or a new source; cancellation must not discard a paid response.
      const currentRun = runs.get(run.runId);
      const currentMessage = messages.get(run.messageId);
      if (
        currentRun?.botId !== bot.id ||
        currentRun.conversationId !== run.conversationId ||
        currentRun.messageId !== run.messageId ||
        currentMessage?.botId !== bot.id ||
        currentMessage.conversationId !== run.conversationId ||
        currentMessage.runId !== run.runId
      )
        throw new AgentError("permission_denied");
      attachments.persist(run.messageId, batch as PreparedAttachments, bot.id);
      messages.update(run.messageId, { content: finalText, usage });
      artifacts.repo.markGenerated(run.runId);
    });
    committed = true;
    endPost();
    authorization.timing.finish();
    // The paid image is already available while the separate workspace approval is pending.
    emit(() =>
      deps.peer.emit("chat.attachments", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        attachments:
          new AttachmentsRepo(deps.db).forMessages([run.messageId]).get(run.messageId) ?? [],
      }),
    );
    generationSignal.throwIfAborted();
    signal.throwIfAborted();
    await authorization.revalidate();
    signal.throwIfAborted();
    let delivery: ImageDelivery;
    try {
      delivery = await artifacts.exporter.save(
        context,
        target,
        batch.items.map((item) => item.metadata.id),
      );
    } catch {
      // Once the managed image exists, save failure/cancellation cannot discard it or regenerate it.
      delivery = ImageDeliverySchema.parse({
        attachments: "delivered",
        workspace: batch.items.map((item) => {
          const extension =
            item.metadata.mimeType === "image/jpeg" ? "jpg" : item.metadata.mimeType.split("/")[1];
          const fileName = imageExportFileName({
            runId: run.runId,
            attachmentId: item.metadata.id,
            extension: extension as "png" | "jpg" | "webp" | "gif",
          });
          return {
            attachmentId: item.metadata.id,
            fileName,
            targetPath: join(target.cwd, fileName),
            status: signal.aborted ? "cancelled" : "failed",
            errorCode: signal.aborted ? "cancelled" : "file_failed",
          };
        }),
      });
      deps.logger.warn(`Image workspace save incomplete run=${run.runId}`);
    }
    finalText = deps.redactor.redact(
      [finalText, imageDeliveryText(context.language, delivery)].filter(Boolean).join("\n\n"),
    );
    usage = MessageSchema.shape.usage.parse({
      ...(usage as Record<string, unknown>),
      imageDelivery: delivery,
      imageArtifactSourceRunId: run.runId,
      ...(run.routine ? { finalReply: finalText } : {}),
      ...(run.threadId
        ? { taskReply: finalText.slice(0, 100_000).replace(/[\uD800-\uDBFF]$/u, "") }
        : {}),
    });
    let updates: Message[] = [];
    const completed = transaction(deps.db, () => {
      // Content, usage and the done state commit together; no half-delivered message on failure.
      messages.update(run.messageId, { content: finalText, usage });
      replies.content = finalText;
      updates = replies.finish("done", usage);
      runs.finish(run.runId, "done", "stop");
      authorization?.finish("done");
      local.approvals.audit.append({
        botId: bot.id,
        runId: run.runId,
        kind: "image.finished",
        summary: "Image generation completed / 图片生成完成",
        detail: {
          ...metadata,
          target: model?.recipient,
          imageCount: batch?.items.length,
          durationMs: Date.now() - startedAt,
          reasonCode: "done",
        },
      });
      // Successful member output uses the existing automatic completion and attachment source.
      return local.collaboration?.completeRun?.(context, finalText, "stop", []);
    });
    committed = true;
    if (!run.groupId || run.threadId || !messages.hasResultMessage(run.messageId))
      emit(() =>
        deps.peer.emit("chat.delta", {
          ...route,
          runId: run.runId,
          messageId: run.messageId,
          text: finalText,
        }),
      );
    emit(() => replies.publishUpdates(updates));
    emit(() => completed?.());
    emit(() =>
      deps.peer.emit("chat.attachments", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        attachments:
          new AttachmentsRepo(deps.db).forMessages([run.messageId]).get(run.messageId) ?? [],
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
    const code = stopCode(error);
    const cancelled = run.aborted || signal.aborted;
    const exhausted = local?.budgets.repo.get(run.budgetRootRunId ?? run.runId)?.exhaustedReason;
    run.stopCause ??= {
      code:
        exhausted === "repeated_operation"
          ? "repeated_operation"
          : exhausted
            ? "budget_exhausted"
            : code === "image_timeout"
              ? "timeout"
              : "error",
    };
    run.controller.abort(run.stopCause);
    if (batch && !committed) await batch.discard();
    if (committed) {
      retainGeneratedImage(
        deps,
        run,
        replies,
        context.language,
        authorization,
        emit,
        exhausted ? "budget_exhausted" : cancelled ? "aborted" : undefined,
      );
      return;
    }
    // image_timeout is an error (with Retry), never "aborted": the user did not stop it.
    const updates = transaction(deps.db, () => {
      const updates = replies.finish(
        code === "aborted" ? "aborted" : "error",
        { stopReason: code },
        code,
      );
      runs.finish(
        run.runId,
        code === "aborted" ? "aborted" : "error",
        code === "aborted" ? "aborted" : "error",
        code,
      );
      authorization?.finish(code === "aborted" ? "aborted" : "error");
      local?.approvals.audit.append({
        botId: bot.id,
        runId: run.runId,
        kind: "image.finished",
        summary: "Image generation stopped / 图片生成停止",
        detail: {
          ...metadata,
          reasonCode: code === "image_timeout" ? "timeout" : code,
          durationMs: startedAt ? Date.now() - startedAt : 0,
        },
      });
      return updates;
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
    if (code === "internal") deps.logger.error(`Image run ${run.runId} internal`);
    else deps.logger.warn(`Image run ${run.runId} ${code}`);
  } finally {
    try {
      local?.budgets.end(context);
      replies.interruptAdditions();
    } finally {
      run.stopCause ??= { code: "completed" };
      run.controller.abort(run.stopCause);
      deps.finished(run);
    }
  }
}
