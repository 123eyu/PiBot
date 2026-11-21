import { RpcError } from "@pibot/protocol-base";
import { MessagesRepo, transaction } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { LocalService } from "../../local-service.ts";
import { readUserQuestion } from "./user-question-source.ts";

/** Closing an obsolete question records the user's answer without scheduling more work. */
export function registerDismissQuestion(handle: KernelRegisterRpc, local: LocalService) {
  handle("execution.question.dismiss", async ({ messageId }, { signal }) => {
    signal.throwIfAborted();
    transaction(local.deps.db, () => {
      const current = readUserQuestion(local, messageId);
      if (
        current.pause.fixedOptions ||
        Date.now() - Date.parse(current.message.createdAt) <= 3 * 86_400_000
      )
        throw new RpcError(-32602, "question_unavailable");
      // An identical repeated click is safe, including after an uncertain RPC response.
      if (current.pause.answer) {
        if (current.pause.answer.text === "不用继续了") return;
        throw new RpcError(-32602, "question_already_answered");
      }
      const messages = new MessagesRepo(local.deps.db);
      if (messages.hasUserAfter(messageId) || messages.hasUserAfter(current.message.id))
        throw new RpcError(-32602, "question_changed");
      for (const message of current.message.id === current.display.id
        ? [current.message]
        : [current.message, current.display]) {
        const usage =
          message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
            ? message.usage
            : {};
        messages.update(message.id, {
          usage: {
            ...usage,
            executionPause: {
              ...current.pause,
              ...(message.id !== current.message.id ? { sourceMessageId: current.message.id } : {}),
              answer: { text: "不用继续了", answeredAt: new Date().toISOString() },
            },
          },
        });
      }
      local.approvals.audit.append({
        botId: current.bot.id,
        runId: current.message.runId ?? undefined,
        kind: "execution.todo.changed",
        summary: "Dismissed an obsolete question / 关闭了旧问题",
        detail: { target: current.message.id, actor: "user", reasonCode: "question_dismissed" },
      });
    });
    local.deps.peer.emit("inbox.changed", {});
    // Both the source and its optional group mirror refresh through the existing event.
    const current = readUserQuestion(local, messageId);
    local.deps.peer.emit("execution.question.answered", {
      botId: current.bot.id,
      conversationIds: [...new Set([current.message.conversationId, current.conversation.id])],
    });
    return { ok: true as const };
  });
}
