import type { LocalService } from "@pibot/brain/kit";
import { type ImageDelivery, ImageDeliverySchema, type Message } from "@pibot/images-contract/full";
import {
  ConversationsRepo,
  GroupTasksRepo,
  ImageArtifactsRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import type { ImageWorkspaceTarget } from "./image-workspace-target.ts";

function usage(message: Message) {
  return message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
    ? message.usage
    : {};
}
function notify(local: LocalService, message: Message) {
  if (!message.botId) return;
  const conversation = new ConversationsRepo(local.deps.db).get(message.conversationId);
  try {
    if (!message.runId) {
      // A public task result is a history row, not a new run completion or a forged chat.message.
      if (conversation?.groupId) {
        const task = message.taskResult
          ? new GroupTasksRepo(local.deps.db, (value) => local.deps.redactor.redact(value)).get(
              message.taskResult.taskId,
            )
          : undefined;
        if (task?.groupId === conversation.groupId && task.status === "done")
          local.deps.peer.emit("group.task", { task });
        local.deps.peer.emit("groups.changed", {
          groupId: conversation.groupId,
          reason: "updated",
        });
        local.deps.peer.emit("sidebar.changed", {
          conversationKey: `group:${conversation.groupId}`,
        });
        local.deps.peer.emit("inbox.changed", {});
      }
      return;
    }
    local.deps.peer.emit("chat.message", {
      botId: message.botId,
      conversationId: message.conversationId,
      runId: message.runId,
      messageId: message.id,
      message,
    });
  } catch {
    local.deps.logger.warn("Image delivery notification deferred; history retained");
  }
}
function publicDelivery(
  source: Message,
  message: Message,
  merged: ImageDelivery,
  sourceRunId: string,
) {
  const attached = new Set(message.attachments?.filter((a) => a.kind === "image").map((a) => a.id));
  const safe = merged.workspace.filter((item) => attached.has(item.attachmentId));
  if (!safe.length) return;
  const existingUsage = usage(message),
    existing = ImageDeliverySchema.safeParse(existingUsage.imageDelivery);
  const workspace = new Map(
    existing.success && existing.data.workspace.every((item) => attached.has(item.attachmentId))
      ? existing.data.workspace.map((item) => [item.attachmentId, item])
      : [],
  );
  for (const item of safe) workspace.set(item.attachmentId, item);
  return {
    ...existingUsage,
    imageDelivery: ImageDeliverySchema.parse({
      attachments: "delivered",
      workspace: [...workspace.values()],
    }),
    ...([...attached].every((id) => source.attachments?.some((a) => a.id === id))
      ? { imageArtifactSourceRunId: sourceRunId }
      : {}),
  };
}
/** Commit first, then notify; a notification failure cannot erase a paid managed image. */
export function recordImageWorkspaceDelivery(
  local: LocalService,
  target: ImageWorkspaceTarget,
  delivery: ImageDelivery,
) {
  const messages = new MessagesRepo(local.deps.db);
  const { source, merged } = transaction(local.deps.db, () => {
    const source = messages.get(target.source.messageId);
    if (!source || source.botId !== target.source.botId || source.runId !== target.source.runId)
      throw new Error("image_delivery_source_invalid");
    const previous = usage(source),
      prior = ImageDeliverySchema.safeParse(previous.imageDelivery);
    const results = new Map(
      prior.success ? prior.data.workspace.map((item) => [item.attachmentId, item]) : [],
    );
    for (const item of delivery.workspace) results.set(item.attachmentId, item);
    const merged = ImageDeliverySchema.parse({
      attachments: "delivered",
      workspace: [...results.values()],
    });
    if (
      !merged.workspace.every((item) =>
        source.attachments?.some((a) => a.id === item.attachmentId && a.kind === "image"),
      )
    )
      throw new Error("image_delivery_attachment_invalid");
    messages.update(source.id, {
      usage: { ...previous, imageDelivery: merged, imageArtifactSourceRunId: target.source.runId },
    });
    return { source, merged };
  });
  const updated = messages.get(source.id);
  if (updated) notify(local, updated);
  if (!target.source.groupId) return;
  const artifacts = new ImageArtifactsRepo(local.deps.db);
  let before = "";
  // Reused attachments can acquire unbounded public aliases; stable IDs bound each read and notification batch.
  for (;;) {
    const rows = artifacts.deliveryAliases(target.source.runId, before || undefined);
    const changed: Message[] = [];
    transaction(local.deps.db, () => {
      for (const row of rows) {
        const message = messages.get(row.id);
        if (!message || message.id === source.id) continue;
        const next = publicDelivery(source, message, merged, target.source.runId);
        if (!next) continue;
        messages.update(message.id, { usage: next });
        const result = messages.get(message.id);
        if (result) changed.push(result);
      }
    });
    for (const message of changed) notify(local, message);
    if (rows.length < 50) break;
    before = String(rows.at(-1)?.id);
  }
}
