import type { Approval } from "@pibot/protocol";
import { useConversations } from "../conversations/conversations-context.tsx";
import { botLook } from "../conversations/model.ts";

/** Which Bot asks and which chat the card belongs to, from the shared conversation list. */
export function useApprovalSource() {
  const conversations = useConversations();
  return (approval: Approval) => {
    const bot = conversations.bots.get(approval.botId);
    const group = conversations.rows.find(
      (row) =>
        row.kind === "group" &&
        !!approval.conversationId &&
        row.topicId === approval.conversationId,
    );
    const chat = group ?? conversations.find("bot", approval.botId);
    return {
      look: bot ? botLook(bot) : undefined,
      botName: bot?.name ?? "",
      where: chat?.name ?? bot?.name ?? "",
      chat: chat ? { kind: chat.kind, id: chat.id } : undefined,
    };
  };
}
