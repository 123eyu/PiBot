import type { DatabaseSync } from "node:sqlite";
import { visibleGroupMessage } from "@pibot/brain/orchestration-kit";
import { type Group, ImageDeliverySchema, type Message } from "@pibot/protocol-base";
import { AttachmentsRepo, ImageArtifactsRepo, MessagesRepo, RunsRepo } from "@pibot/storage";

export function groupImageDelivery(message: Message, db?: DatabaseSync, group?: Group) {
  const sourceRunId = db && group ? groupImageSourceRun(db, group, message) : undefined;
  const run = db && sourceRunId ? new RunsRepo(db).get(sourceRunId) : undefined;
  const source = db && run ? new MessagesRepo(db).get(run.messageId) : undefined;
  // Save-only retries update the generation source; use its current fact rather than stale copied text.
  const usage = source?.usage ?? message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const delivery = ImageDeliverySchema.safeParse(usage.imageDelivery);
  if (
    !delivery.success ||
    !delivery.data.workspace.every((saved) =>
      message.attachments?.some((a) => a.id === saved.attachmentId && a.kind === "image"),
    )
  )
    return;
  return delivery.data;
}

// Only persisted generation ownership supplies a reusable identity; copied text/guessed UUIDs do not.
export function groupImageSourceRun(
  db: DatabaseSync,
  group: Group,
  message: Message,
): string | undefined {
  const images = message.attachments?.filter((a) => a.kind === "image") ?? [];
  if (!images.length) return;
  const repo = new AttachmentsRepo(db),
    runs = new RunsRepo(db),
    messages = new MessagesRepo(db);
  let sourceRunId: string | undefined;
  for (const image of images) {
    const stored = repo.get(image.id),
      source = stored ? messages.get(stored.messageId) : undefined;
    const usage =
      source?.usage && typeof source.usage === "object" && !Array.isArray(source.usage)
        ? source.usage
        : {};
    const run = source?.runId ? runs.get(source.runId) : undefined;
    if (
      !stored ||
      !source ||
      source.role !== "assistant" ||
      !visibleGroupMessage(db, group, source) ||
      !run ||
      usage.imageGeneration !== true ||
      ((run.status !== "done" || run.stopReason !== "stop") &&
        !new ImageArtifactsRepo(db).get(run.id)?.generatedAt) ||
      run.groupId !== group.id ||
      run.messageId !== source.id ||
      run.botId !== stored.botId ||
      source.botId !== stored.botId ||
      source.conversationId !== run.conversationId ||
      repo.groupId(image.id) !== group.id ||
      !group.members.some((m) => m.botId === stored.botId) ||
      (sourceRunId && sourceRunId !== run.id)
    )
      return;
    sourceRunId = run.id;
  }
  return sourceRunId;
}
