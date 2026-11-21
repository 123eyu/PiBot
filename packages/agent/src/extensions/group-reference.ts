import { createHash } from "node:crypto";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { base64Bytes, type ImageContent, ImageContentSchema } from "@pibot/protocol-base";
import type { GroupContextPart, PromptContext } from "../core/types.ts";
import { fitGroupHeader } from "./group-header.ts";
import { STATE_MARKER } from "./volatile-state.ts";

export type Group = NonNullable<PromptContext["group"]>;
export type GroupImage = NonNullable<Group["images"]>[number];
type Message = ContextEvent["messages"][number];

// Group text rides in reference messages and must never impersonate the trusted state tags.
export function groupText(text: string) {
  return text
    .replace(
      /<\/?(?:execution|routineResume|runResume|routineLedger|routine|previousRoutineResult)/gi,
      (tag) => tag.replace("<", "＜"),
    )
    .replaceAll(STATE_MARKER, STATE_MARKER.replace("[", "［"));
}

const neutralParts = (parts: GroupContextPart[]) =>
  parts.map((part) => ({
    ...part,
    text: groupText(part.text),
    ...(part.compact !== undefined ? { compact: groupText(part.compact) } : {}),
  }));

/** Live (non-profile) parts with group text neutralized: task snapshots and status lines. */
export const liveParts = (group: Group) =>
  neutralParts((group.parts ?? []).filter((part) => !part.stable));

export function groupProfile(group: Group | undefined, maxBytes: number) {
  if (!group) return;
  // A fixed share of the existing header budget makes full/compact profile selection independent
  // of changing tasks and messages. The remaining header space still belongs to live group data.
  return fitGroupHeader(
    groupText(group.information),
    neutralParts((group.parts ?? []).filter((part) => part.stable)),
    0,
    "",
    Math.floor(maxBytes / 4),
  );
}

/** One reference line per distinct message id, oldest first. */
export function referenceLines(group: Group) {
  const seen = new Set<string>();
  return group.messages
    .filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    })
    .map((m) => ({
      id: m.id,
      text: groupText(
        `${m.botName ?? m.role}: ${m.text}${m.attachments?.length ? `\nDelivered attachments / 已交付附件: ${JSON.stringify(m.attachments)}` : ""}${m.sourceRunId ? `\nReusable image sourceRunId / 可复用图片来源: ${m.sourceRunId}` : ""}${m.imageDelivery ? `\nActual image delivery / 实际图片交付: ${JSON.stringify(m.imageDelivery)}` : ""}`,
      ),
      priority: !!m.priority,
    }));
}

/** Keeps the highest-priority, most recent lines within `budget` bytes, in original order. */
export function selectLines(lines: { text: string; priority: boolean }[], budget: number) {
  let remaining = budget;
  const selected = new Map<number, string>();
  const order = lines
    .map((line, i) => ({ ...line, i }))
    .sort((a, b) => Number(b.priority) - Number(a.priority) || b.i - a.i);
  for (const line of order) {
    const size = Buffer.byteLength(line.text) + 1;
    if (size > remaining) continue;
    selected.set(line.i, line.text);
    remaining -= size;
  }
  return {
    text: [...selected]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join("\n"),
    omitted: lines.length - selected.size,
  };
}

export const digest = (data: string) => createHash("sha256").update(data).digest("hex");

/** Which group image attachments belong to a priority (current) message. */
export const imageOwnership = (group: Group) =>
  new Map(
    group.messages.flatMap(
      (m) =>
        m.attachments
          ?.filter((a) => a.kind === "image")
          .map((a) => [`${m.id}:${a.id}`, !!m.priority] as const) ?? [],
    ),
  );

/** Shown instead of an image the group no longer manages (also for persisted references). */
export const IMAGE_NOT_LOADED =
  "Image not loaded: current managed group ownership or image budget no longer permits it. / 图片未加载：本群当前受管附件归属或图片预算已变化。";

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Image context budget for one request: at most five images and 20 MB across SDK messages and
 * group reference blocks, each distinct image once. Of the group's own images only those it
 * currently manages (`fresh`) may reach the model; tool results are the Bot's own output.
 */
export class ImageBudget {
  private count = 0;
  private bytes = 0;
  private readonly hashes = new Set<string>();
  constructor(
    readonly canSee: boolean,
    private readonly fresh: Set<string>,
  ) {}

  /** The message with every image block kept or replaced by a short explanation. */
  message(message: Message): Message {
    if (
      (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") ||
      !Array.isArray(message.content)
    )
      return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "image") return part;
        const image = ImageContentSchema.parse(part),
          size = base64Bytes(image.data),
          hash = digest(image.data);
        // Ownership guards group attachments (a removed or re-owned image must not resurface). A
        // tool result's image is the Bot's own output (a screenshot, an image it opened), never a
        // group attachment, so only the budget below applies to it.
        if (message.role !== "toolResult" && !this.fresh.has(hash))
          return { type: "text" as const, text: IMAGE_NOT_LOADED };
        if (this.canSee && this.hashes.has(hash))
          return {
            type: "text" as const,
            text: "Duplicate image already loaded in this context / 同一图片已在本次上下文加载。",
          };
        if (!this.canSee || !this.fits(size))
          return {
            type: "text" as const,
            text: "Image omitted: unsupported model or image context budget / 图片未加载：模型不支持或图片预算裁剪。",
          };
        this.take(hash, size);
        return image;
      }),
    } as Message;
  }

  /** Picks group blocks of one ownership class; `ids` collects every attachment now visible. */
  group(
    blocks: GroupImage[],
    ownership: Map<string, boolean>,
    priority: boolean,
    ids: Set<string>,
  ) {
    const images: ImageContent[] = [];
    for (const block of blocks) {
      if (
        !this.canSee ||
        ids.has(block.attachmentId) ||
        ownership.get(`${block.messageId}:${block.attachmentId}`) !== priority
      )
        continue;
      const image = ImageContentSchema.parse(block.image),
        size = base64Bytes(image.data),
        hash = digest(image.data);
      if (this.hashes.has(hash)) {
        ids.add(block.attachmentId);
        continue;
      }
      if (!this.fits(size)) continue;
      images.push(image);
      this.take(hash, size);
      ids.add(block.attachmentId);
    }
    return images;
  }

  /** Counts images an earlier request of this run already placed, without re-deciding them. */
  account(images: ImageContent[]) {
    for (const image of images) this.take(digest(image.data), base64Bytes(image.data));
  }

  /** False when an image placed earlier in the run is no longer managed by the group. */
  stillFresh(images: ImageContent[]) {
    return images.every((image) => this.fresh.has(digest(image.data)));
  }

  private fits(size: number) {
    return this.count < MAX_IMAGES && this.bytes + size <= MAX_IMAGE_BYTES;
  }

  private take(hash: string, size: number) {
    this.count++;
    this.bytes += size;
    this.hashes.add(hash);
  }
}

/** Visible-image status lines for the reference header. */
export function imageStatus(
  statuses: NonNullable<Group["imageStatus"]>,
  canSee: boolean,
  visible: Set<string>,
) {
  return statuses.map((s) => ({
    ...s,
    status: !canSee
      ? "unsupported"
      : visible.has(s.attachmentId)
        ? "loaded"
        : s.status === "loaded"
          ? "budget"
          : s.status,
  }));
}
