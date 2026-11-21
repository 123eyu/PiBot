import type { LocalToolCall } from "@pibot/agent";
import { explainPolicyResult } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import { BotsRepo, ConversationsRepo, GroupsRepo, MessagesRepo, RunsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { auditYolo, runYolo } from "../../core/yolo.ts";
import type { LocalService } from "../../local-service.ts";
import { groupAuthorization } from "./local-prepare.ts";

/** Business confirmations are outside policy's ask/allow decision, but use the same live scope. */
export function businessConfirmation(
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
) {
  if (!runYolo(local, context)) return undefined;
  const assertCurrent = () => {
    context.signal.throwIfAborted();
    const { db } = local.deps;
    const source = context.executionTaskId ? local.tasks.source(context) : context;
    const bot = new BotsRepo(db).get(context.botId);
    const message = new MessagesRepo(db).get(context.messageId);
    const run = new RunsRepo(db).get(context.runId);
    const conversation = source.conversationId
      ? new ConversationsRepo(db).get(source.conversationId)
      : undefined;
    const actual = context.conversationId
      ? new ConversationsRepo(db).get(context.conversationId)
      : undefined;
    const member =
      conversation?.kind === "dm"
        ? conversation.botId === context.botId
        : !!conversation?.groupId &&
          new GroupsRepo(db)
            .get(conversation.groupId)
            ?.members.some((entry) => entry.botId === context.botId);
    if (
      !bot ||
      bot.archivedAt ||
      !conversation ||
      conversation.archivedAt ||
      !member ||
      !actual ||
      actual.archivedAt ||
      message?.conversationId !== actual.id ||
      message.botId !== context.botId ||
      message.runId !== context.runId ||
      message.status !== "streaming" ||
      message.role !== "assistant" ||
      run?.status !== "running" ||
      run.botId !== context.botId ||
      run.conversationId !== context.conversationId ||
      run.messageId !== context.messageId ||
      (source.groupId &&
        source.groupAuthorization !== undefined &&
        groupAuthorization(local, source) !== source.groupAuthorization) ||
      !runYolo(local, context) ||
      !local.execution.allows(context, call.tool)
    )
      throw new RpcError(-32602, "business_confirmation_changed");
  };
  return {
    assertCurrent,
    audit() {
      assertCurrent();
      auditYolo(
        local,
        context,
        call,
        explainPolicyResult(
          {
            decision: "allow",
            reason: "yolo",
            risk: "normal",
            facts: [],
            canRemember: false,
          },
          "yolo",
          "yolo",
        ),
      );
    },
  };
}
