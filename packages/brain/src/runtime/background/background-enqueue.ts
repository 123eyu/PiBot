import type { Bot, Run } from "@pibot/protocol-base";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  BackgroundContinuationsRepo,
  GroupCyclesRepo,
  MessagesRepo,
  RunsRepo,
  transaction,
} from "@pibot/storage";
import type { ChatService } from "../../conversations/chat/chat.ts";
import type { LocalService } from "../../local-service.ts";
import type { QueueInput } from "../queue/run-queue.ts";
import {
  type CompletionBatch,
  completionNotice,
  completionTrigger,
} from "./background-completion.ts";

export function enqueueCompletion(
  local: LocalService,
  chat: ChatService,
  rows: CompletionBatch,
  state: { source: Run; bot: Bot },
  results: Map<string, string>,
  explicit: boolean,
) {
  const row = rows[0];
  if (!row.conversationId) return;
  const { source, bot } = state;
  const { db } = local.deps;
  const triggerKey = completionTrigger(rows);
  if (new RunsRepo(db).trigger(triggerKey)) return;

  const notice = completionNotice(local, rows, chat.currentLanguage() === "zh", results);
  const text = notice.text;
  const input: QueueInput = {
    bot,
    conversationId: row.conversationId,
    text,
    triggerKey,
    automatic: true,
    parentRunId: source.id,
    ancestry: source.ancestry,
    ...(source.groupId
      ? { budgetRootRunId: local.tasks.budgetRoot(source), enforceBudgetCost: true }
      : {}),
    backgroundCommandId: row.id,
    backgroundResults: notice.reference,
    ...(source.groupId
      ? {
          groupId: source.groupId,
          cycleId: new GroupCyclesRepo(db).get(source.groupId).cycleId ?? undefined,
          taskId: source.taskId ?? undefined,
          ...(source.kind === "group_task"
            ? { threadId: source.conversationId, kind: source.kind }
            : {}),
        }
      : {}),
  };
  const record = transaction(db, () => {
    if (
      input.groupId &&
      (!input.cycleId || new GroupCyclesRepo(db).consume(input.groupId, input.cycleId) !== "ok")
    )
      throw new RpcError(RpcErrorCodes.busy, "background_group_limit");
    const event = new MessagesRepo(db).create({
      conversationId: input.conversationId,
      role: "user",
      content: text,
      status: "done",
      markUnread: false,
      usage: {
        systemEvent: true,
        trigger: "background_finished",
        backgroundCommandId: row.id,
        backgroundCommandIds: rows.map((item) => item.id),
        backgroundBotId: bot.id,
      },
    });
    input.userMessageId = event.id;
    const run = chat.queue.insert(input);
    new BackgroundContinuationsRepo(db).bind(
      rows.map((item) => item.id),
      run.id,
    );
    local.approvals.audit.append({
      botId: bot.id,
      runId: run.id,
      kind: "run.resumed",
      summary: "Background completion / 后台命令完成接续",
      detail: {
        actor: explicit ? "user" : "automatic",
        ...(source.groupId ? { groupId: source.groupId } : {}),
        trigger: "background_finished",
        backgroundCommandId: row.id,
      },
    });
    return run;
  });
  chat.queue.publish(record, input);
}
