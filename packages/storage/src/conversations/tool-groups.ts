import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MessagesRepo } from "../workspace/repositories.ts";

const groupsSchema = z.array(z.string().min(1).max(100)).max(3);

/** Visibility hints belong to the owning reply, so deleting a conversation deletes its history. */
export class ConversationToolGroupsRepo {
  constructor(private readonly db: DatabaseSync) {}

  recent(botId: string, conversationId: string): string[] {
    const rows = this.db
      .prepare(`SELECT usage FROM messages WHERE bot_id=? AND conversation_id=?
        AND role='assistant' AND run_id IS NOT NULL ORDER BY rowid DESC LIMIT 32`)
      .all(botId, conversationId);
    const groups = new Set<string>();
    for (const row of rows) {
      const usage: unknown = row.usage ? JSON.parse(String(row.usage)) : null;
      const parsed = groupsSchema.safeParse(
        usage && typeof usage === "object" && !Array.isArray(usage)
          ? (usage as Record<string, unknown>).toolGroups
          : undefined,
      );
      if (!parsed.success) continue;
      for (const group of parsed.data) {
        groups.add(group);
        if (groups.size === 3) return [...groups];
      }
    }
    return [...groups];
  }

  remember(messageId: string, botId: string, conversationId: string, groups: readonly string[]) {
    const selected = groupsSchema.parse(groups);
    const messages = new MessagesRepo(this.db);
    const message = messages.get(messageId);
    if (
      !message?.runId ||
      message.role !== "assistant" ||
      message.botId !== botId ||
      message.conversationId !== conversationId
    )
      throw new Error("tool_groups_scope_changed");
    const usage = message.usage;
    messages.update(messageId, {
      usage: {
        ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
        toolGroups: selected,
      },
    });
  }
}
