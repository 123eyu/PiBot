import type { DatabaseSync } from "node:sqlite";
import {
  type ConversationYoloState,
  ConversationYoloStateSchema,
  IdSchema,
} from "@pibot/protocol-base";
import { type Conversation, ConversationsRepo } from "./conversations.ts";

/**
 * The YOLO switch stored on one conversation (`conversations.yolo_at`). Only a DM topic of
 * its own (not a routine's topic) or a group conversation can hold it; a task thread follows its
 * group conversation. A new conversation row starts with NULL, so nothing is inherited.
 */
export class ConversationYoloRepo {
  private readonly conversations: ConversationsRepo;
  constructor(private readonly db: DatabaseSync) {
    this.conversations = new ConversationsRepo(db);
  }

  /** The conversation that can hold the switch, or undefined when it cannot have one. */
  switchable(conversationId: string): Conversation | undefined {
    const conversation = this.conversations.get(IdSchema.parse(conversationId));
    if (!conversation || conversation.archivedAt) return undefined;
    if (conversation.kind === "dm") return conversation.routineId ? undefined : conversation;
    return conversation.kind === "group" ? conversation : undefined;
  }

  get(conversationId: string): ConversationYoloState {
    const conversation = this.switchable(conversationId);
    if (!conversation) throw new TypeError("yolo_unavailable");
    const row = this.db
      .prepare("SELECT yolo_at FROM conversations WHERE id=?")
      .get(conversation.id);
    const enabledAt = row?.yolo_at == null ? null : String(row.yolo_at);
    return ConversationYoloStateSchema.parse({
      conversationId: conversation.id,
      enabled: enabledAt !== null,
      enabledAt,
    });
  }

  /** Metadata only: does not touch updated_at, so the topic list order stays. */
  set(conversationId: string, enabled: boolean): ConversationYoloState {
    const conversation = this.switchable(conversationId);
    if (!conversation) throw new TypeError("yolo_unavailable");
    this.db
      .prepare(
        "UPDATE conversations SET yolo_at=CASE WHEN ? THEN COALESCE(yolo_at, ?) ELSE NULL END WHERE id=?",
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), conversation.id);
    return this.get(conversation.id);
  }

  /**
   * Whether a run in `conversationId` (a topic, group conversation or task thread of `groupId`)
   * is under YOLO now. Read at every decision, so turning it off takes effect at the next one.
   */
  active(conversationId: string, groupId?: string): boolean {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.archivedAt) return false;
    if (groupId !== undefined && conversation.groupId !== groupId) return false;
    const holder =
      conversation.kind === "thread" && conversation.threadOf
        ? this.conversations.get(conversation.threadOf)
        : conversation;
    if (!holder || holder.archivedAt) return false;
    if (holder.kind === "dm" ? !!holder.routineId || !!groupId : holder.kind !== "group")
      return false;
    if (holder.kind === "group" && holder.groupId !== conversation.groupId) return false;
    const row = this.db.prepare("SELECT yolo_at FROM conversations WHERE id=?").get(holder.id);
    return row?.yolo_at != null;
  }
}
