import type { AgentErrorCode } from "@pibot/protocol-base";
import { RunsRepo, transaction } from "@pibot/storage";
import { ChatReplies } from "../../conversations/chat/chat-replies.ts";
import type { ChatRun } from "../queue/chat-run.ts";
import type { ExternalAgentRunHost } from "./port.ts";

/** Settles an agent Bot's run that cannot start at all (no external-agents capability). */
export function failAgentRun(deps: ExternalAgentRunHost, run: ChatRun, code: AgentErrorCode) {
  const route = {
    botId: run.botId,
    conversationId: run.conversationId,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
  };
  try {
    const replies = new ChatReplies(deps.db, run, deps.peer, deps.redactor, () => {});
    const updates = transaction(deps.db, () => {
      const updates = replies.finish("error", { stopReason: code }, code);
      new RunsRepo(deps.db).finish(run.runId, "error", "error", code);
      return updates;
    });
    replies.publishUpdates(updates);
    deps.peer.emit("chat.error", {
      ...route,
      runId: run.runId,
      messageId: run.messageId,
      code,
      message: code,
    });
  } finally {
    run.stopCause ??= { code: "error" };
    run.controller.abort(run.stopCause);
    deps.finished(run);
  }
}
