import { randomUUID } from "node:crypto";
import type { LocalService, RunQueue, ToolRunContext } from "@pibot/brain/kit";
import { activeGroup, authorizationSnapshot, readManagedImage } from "@pibot/brain/kit";
import { ExecError } from "@pibot/execution";
import {
  ImageDeliverySchema,
  type ImageOperation,
  type MethodParams,
  RpcError,
} from "@pibot/images-contract/full";
import {
  BotsRepo,
  ConversationsRepo,
  ImageArtifactsRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import { imageDeliveryText } from "../run/image-delivery-text.ts";
import { ImageWorkspaceExporter } from "../workspace/image-workspace-exporter.ts";

/** Both RPC operations and model tools enter through LocalRun; this service has no generation port. */
export class ImageArtifactService {
  readonly repo: ImageArtifactsRepo;
  readonly exporter: ImageWorkspaceExporter;
  constructor(private readonly local: LocalService) {
    this.repo = new ImageArtifactsRepo(local.deps.db);
    this.exporter = new ImageWorkspaceExporter(local, {
      get: (key) => this.repo.receiptGet(key),
      put: (key, receipt) => this.repo.receiptPut(key, receipt),
    });
  }
  assertVisible(
    context: Pick<ToolRunContext, "botId" | "conversationId" | "groupId" | "threadId" | "runId">,
    operation: ImageOperation,
  ) {
    if (!context.conversationId) throw new RpcError(-32602, "image_source_unavailable");
    try {
      return this.repo.resolveSource(
        operation.sourceRunId,
        { ...context, conversationId: context.conversationId },
        operation.attachmentIds,
      );
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith("image_artifact_"))
        throw new RpcError(-32602, "image_source_unavailable");
      throw error;
    }
  }
  enqueue(queue: RunQueue, params: MethodParams["images.reuse"]) {
    this.local.shutdown.signal.throwIfAborted();
    const bot = new BotsRepo(this.local.deps.db).get(params.botId);
    const conversation = new ConversationsRepo(this.local.deps.db).get(params.conversationId);
    if (!bot || bot.archivedAt || !conversation || conversation.archivedAt)
      throw new RpcError(-32602, "image_source_unavailable");
    const groupId = conversation.groupId ?? undefined;
    if (groupId) activeGroup(this.local.deps.db, groupId, bot.id, conversation.id);
    else if (conversation.kind !== "dm" || conversation.botId !== bot.id)
      throw new RpcError(-32602, "image_source_unavailable");
    const operation: ImageOperation = {
      action: params.action,
      sourceRunId: params.sourceRunId,
      ...(params.attachmentIds ? { attachmentIds: params.attachmentIds } : {}),
    };
    // A queued identity is not authorization. Execution re-reads source/owner and current policy.
    const runId = randomUUID();
    this.assertVisible(
      {
        botId: bot.id,
        conversationId: conversation.id,
        groupId,
        runId,
        ...(conversation.kind === "thread" ? { threadId: conversation.id } : {}),
      },
      operation,
    );
    const input = {
      bot,
      conversationId: conversation.id,
      groupId,
      ...(conversation.kind === "thread" ? { threadId: conversation.id } : {}),
      text: "",
      userInitiated: true,
      runId,
      imageOperation: operation,
    };
    const record = transaction(this.local.deps.db, () => queue.insert(input));
    queue.publish(record, input);
    return {
      runId: record.id,
      assistantMessageId: record.messageId,
      conversationId: conversation.id,
    };
  }
  async execute(context: ToolRunContext, operation: ImageOperation) {
    const signal = AbortSignal.any([
      context.signal,
      this.local.shutdown.signal,
      AbortSignal.timeout(20_000),
    ]);
    const source = this.assertVisible(context, operation);
    const snapshot = authorizationSnapshot(this.local, context.botId, context);
    const images = [];
    let total = 0;
    for (const attachment of source.attachments) {
      if (total + attachment.metadata.size > 20 * 1024 * 1024) break;
      const loaded = await readManagedImage(this.local.deps, attachment.metadata.id, signal);
      images.push(loaded.image);
      total += loaded.bytes.byteLength;
    }
    this.assertVisible(context, operation);
    if (snapshot !== authorizationSnapshot(this.local, context.botId, context))
      throw new ExecError("outside_workplace");
    context.signal.throwIfAborted();
    if (operation.action === "inspect") {
      context.imageResultSources?.add(operation.sourceRunId);
      if (context.imageResultSources && context.imageResultSources.size > 5)
        context.imageResultSources.delete(
          context.imageResultSources.values().next().value as string,
        );
    }
    if (operation.action === "save") {
      // Approval waits use the live run signal, independent of the preceding cache IO deadline.
      await this.exporter.save(
        context,
        source.artifact.target,
        source.attachments.map((a) => a.metadata.id),
      );
    } else if (operation.action === "resend") {
      transaction(this.local.deps.db, () => {
        this.assertVisible(context, operation);
        this.repo.link(
          operation.sourceRunId,
          context.messageId,
          source.attachments.map((a) => a.metadata.id),
        );
        this.local.approvals.audit.append({
          botId: context.botId,
          runId: context.runId,
          kind: "file.sent",
          summary: "Shared generated image / 已重发生成图片",
          detail: {
            toolName: "image_result",
            category: "read_file",
            imageCount: source.attachments.length,
          },
        });
      });
      try {
        this.local.deps.peer.emit("chat.attachments", {
          botId: context.botId,
          conversationId: context.conversationId,
          ...(context.groupId ? { groupId: context.groupId } : {}),
          ...(context.threadId ? { threadId: context.threadId } : {}),
          runId: context.runId,
          messageId: context.messageId,
          attachments: source.attachments.map((a) => a.metadata),
        });
      } catch {
        this.local.deps.logger.warn(
          "Image reuse notification deferred; history retains attachments",
        );
      }
    }
    const latest = this.assertVisible(context, operation);
    const message = new MessagesRepo(this.local.deps.db).get(
      latest.artifact.target.source.messageId,
    );
    const usage = message?.usage;
    const delivery = ImageDeliverySchema.safeParse(
      usage && typeof usage === "object" && !Array.isArray(usage) ? usage.imageDelivery : undefined,
    );
    const metadata = {
      sourceRunId: operation.sourceRunId,
      generation: "succeeded",
      workspaceState: "last_recorded",
      action: operation.action,
      attachments: latest.attachments.map((a) => a.metadata),
      ...(delivery.success ? { imageDelivery: delivery.data } : {}),
      imageInput: images.length < source.attachments.length ? "budget_trimmed" : "available",
    };
    // The adapter decides whether the actual current model can consume these blocks.
    return {
      text: `${JSON.stringify(metadata)}\n${imageDeliveryText(context.language, delivery.success ? delivery.data : undefined)}`,
      images: operation.action === "inspect" ? images : [],
      summary: "image_result",
    };
  }
}
