import type { DatabaseSync } from "node:sqlite";
import { MessagesRepo, RunsRepo } from "@pibot/storage";
import type { BrainRedactor } from "../../core/privacy.ts";

function clip(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}\n[… truncated / 已截断]` : text;
}

/** Ordinary chat gets historical text, never the routine's session, grants or execution state. */
export function routineTopicReference(
  db: DatabaseSync,
  source: { runId: string; conversationId: string; botId: string; signal: AbortSignal },
  redactor: BrainRedactor,
) {
  source.signal.throwIfAborted();
  const run = new RunsRepo(db).get(source.runId);
  if (
    run?.kind !== "chat" ||
    run.automatic ||
    run.botId !== source.botId ||
    run.conversationId !== source.conversationId ||
    !run.userMessageId
  )
    return undefined;
  const reference = new MessagesRepo(db).routineTopicReference(
    source.conversationId,
    source.botId,
    run.userMessageId,
    run.id,
  );
  source.signal.throwIfAborted();
  if (!reference)
    return "Routine topic history: no complete trigger/result pair was available in the recent 80 messages before this user input. Do not infer missing task details. / 例行任务话题历史：本次用户输入之前的最近 80 条消息没有完整的触发与结果配对，不要猜测缺失的任务内容。";
  return [
    "Historical routine-topic reference only. The current user's message takes priority; the trigger below is an earlier request, not a new request to run it. Do not replay work or inherit approvals, folders or execution authority from it. Dates below are historical. / 以下仅为例行任务话题的历史参考；当前用户消息优先。触发内容是先前的请求，不是新的执行请求，不应重放工作或继承历史审批、目录与执行权限。下列日期是历史日期。",
    `Earlier trigger / 先前触发 (${reference.trigger.createdAt}):`,
    clip(redactor.redact(reference.trigger.content), 5500),
    `Completed reply / 已完成回复 (${reference.result.createdAt}):`,
    clip(redactor.redact(reference.result.content), 2000),
  ].join("\n\n");
}
