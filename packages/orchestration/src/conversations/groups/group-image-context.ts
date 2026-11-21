import type { DatabaseSync } from "node:sqlite";
import type { PromptContext } from "@pibot/agent";
import type { ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  activeGroup,
  invalidAttachment,
  readManagedImage,
  visibleGroupMessage,
} from "@pibot/brain/orchestration-kit";
import type { ModelInfo } from "@pibot/protocol-base";
import { AttachmentsRepo, BotsRepo, MessagesRepo } from "@pibot/storage";
import { groupImageReferences } from "./group-image-references.ts";

export const GROUP_IMAGE_COUNT = 5;
export const GROUP_IMAGE_BYTES = 20 * 1024 * 1024;
type GroupImageContext = Pick<NonNullable<PromptContext["group"]>, "images" | "imageStatus">;

/** Reads already converted managed images without allocating new attachments or caching owner snapshots. */
export class GroupImageContextLoader {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
  ) {}
  async prepare(
    context: ToolRunContext,
    model: Pick<ModelInfo, "input">,
    signal: AbortSignal,
  ): Promise<GroupImageContext> {
    signal.throwIfAborted();
    const group = activeGroup(
      this.db,
      context.groupId as string,
      context.botId,
      context.conversationId,
    );
    const refs = groupImageReferences(this.db, context, group).sort(
      (a, b) => Number(b.priority) - Number(a.priority),
    );
    const result: Required<GroupImageContext> = { images: [], imageStatus: [] };
    const seen = new Set<string>();
    let remaining = GROUP_IMAGE_BYTES;
    // A generation model is not a conversational image consumer: history must not become implicit reference input.
    const generationBot = new BotsRepo(this.db).get(context.botId)?.category === "image";
    const supported = model.input.includes("image") && !generationBot;
    for (const { message } of refs)
      for (const metadata of message.attachments ?? []) {
        if (metadata.kind !== "image" || seen.has(metadata.id)) continue;
        seen.add(metadata.id);
        const state: NonNullable<GroupImageContext["imageStatus"]>[number] = {
          attachmentId: metadata.id,
          status: generationBot ? "not_loaded" : supported ? "unavailable" : "unsupported",
        };
        result.imageStatus.push(state);
        if (!supported) continue;
        signal.throwIfAborted();
        if (result.images.length >= GROUP_IMAGE_COUNT || metadata.size > remaining) {
          state.status = "budget";
          continue;
        }
        try {
          const stored = this.authorized(context, message.id, metadata.id);
          const { image, bytes } = await readManagedImage(
            { db: this.db, dataDir: this.dataDir },
            metadata.id,
            signal,
          );
          signal.throwIfAborted();
          const fresh = this.authorized(context, message.id, metadata.id);
          if (
            fresh.path !== stored.path ||
            fresh.botId !== stored.botId ||
            bytes.length > remaining
          )
            invalidAttachment();
          result.images.push({ messageId: message.id, attachmentId: metadata.id, image });
          remaining -= bytes.length;
          state.status = "loaded";
        } catch {
          // A missing/changed result remains visible as metadata; cancellation must still stop the run.
          signal.throwIfAborted();
          state.status = "unavailable";
        }
      }
    signal.throwIfAborted();
    groupImageReferences(
      this.db,
      context,
      activeGroup(this.db, group.id, context.botId, context.conversationId),
    );
    return result;
  }
  /**
   * Rechecks one message and attachment against the database. The full reference list is built
   * once before the loop and revalidated once after it; rebuilding it per image ran thousands of
   * synchronous queries before each member call and stalled the brain's event loop.
   */
  private authorized(context: ToolRunContext, messageId: string, attachmentId: string) {
    const group = activeGroup(
      this.db,
      context.groupId as string,
      context.botId,
      context.conversationId,
    );
    const message = new MessagesRepo(this.db).get(messageId);
    const repo = new AttachmentsRepo(this.db),
      stored = repo.get(attachmentId);
    if (
      !message ||
      !visibleGroupMessage(this.db, group, message) ||
      !message.attachments?.some((a) => a.id === attachmentId) ||
      !stored ||
      stored.metadata.kind !== "image" ||
      repo.groupId(attachmentId) !== group.id ||
      !group.members.some((m) => m.botId === stored.botId)
    )
      invalidAttachment();
    return stored;
  }
}
