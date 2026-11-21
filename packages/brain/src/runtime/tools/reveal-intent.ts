import { REVEAL_CONFIRMATION_REASON } from "@pibot/policy";
import { chatReplyTo, messageVisibleText } from "@pibot/protocol-base";
import { MessagesRepo, RunsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

const action = /打开|显示|展示|在访达|在资源管理器|\b(?:show|open|reveal)\b/i;
const negation =
  /不|别|勿|禁止|\b(?:no|not|never|don['’]?t|mustn['’]?t|shouldn['’]?t|can['’]?t|avoid|without)\b/i;
const question = /怎么|如何|怎样|[?？]|\b(?:how|what|why|where|when|who|can|could|would|should)\b/i;
// Match a complete file-manager request, not unrelated action/object words in the same sentence.
// Named folders may contain spaces; other application targets and content requests are refused below.
const extension = String.raw`\.(?:docx?|xlsx?|pptx?|pdf|md|txt|csv|tsv|json|png|jpe?g|gif|webp|svg|zip)`;
const fileName = String.raw`(?:[\p{L}\p{N}_./\\:-]{1,255}${extension}|["「“][\p{L}\p{N}_ ./\\:-]{1,255}${extension}["」”])`;
const target = String.raw`(?:${fileName}(?:\s*(?:文件|file))?|(?:产出|输出|成果|这个|那个|当前|我的)?(?:文件夹|文件|目录)|(?:(?:the|this|that|my|output)\s+){0,3}(?:files?|folders?|director(?:y|ies)))`;
const manager = String.raw`(?:访达|资源管理器|文件管理器|Finder|Explorer|Files|File\s+Explorer)`;
const chineseRequest = new RegExp(
  String.raw`^(?:请\s*)?(?:打开|显示|定位到|在${manager}(?:里|中)?\s*显示)\s*${target}(?:\s*在${manager}(?:里|中)?)?(?:一下|吧)?$`,
  "iu",
);
const englishRequest = new RegExp(
  String.raw`^(?:please\s+)?(?:open|show|reveal)\s+(?:me\s+)?(?:(?:the|this|that|my)\s+)?${target}(?:\s+in\s+(?:the\s+)?${manager})?$`,
  "iu",
);
const otherRequest =
  /内容|正文|路径|聊天|对话|浏览器|网页|搜索|保存|设置|并|以便|用来|读取|阅读|查看|执行|编辑|写入|\b(?:contents?|paths?|chat|browser|web\s*page|search|save|settings|and|while|before|after|read|write|edit|run)\b/i;

/** A conservative keyword gate, never a substitute for path policy or dispatch authorization. */
function requested(text: string): boolean {
  if (text.length > 20_000) return false;
  if (negation.test(text) || question.test(text)) return false;
  // Quoted instructions, examples and fenced code are reference material, not a new request.
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .replace(/^\s*>.*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/「[^」]*」|“[^”]*”|"[^"\n]*"/g, (quote) => (action.test(quote) ? "" : quote));
  const clauses = plain
    .split(/[\n。！？!?；;，,]|\.(?=\s|$)/)
    .map((clause) => clause.trim().replace(/\.$/, ""));
  // Denial wins even when another clause contains the same affirmative keywords.
  if (negation.test(plain)) return false;
  return clauses.some(
    (clause) =>
      !otherRequest.test(clause) && (chineseRequest.test(clause) || englishRequest.test(clause)),
  );
}

export function revealIntentReason(
  local: LocalService,
  context: ToolRunContext,
):
  | "reveal_not_requested"
  | "reveal_unattended_denied"
  | typeof REVEAL_CONFIRMATION_REASON
  | undefined {
  const run = new RunsRepo(local.deps.db).get(context.runId);
  if (
    context.routineRunId ||
    context.routineWorkplace ||
    context.executionTaskId ||
    context.taskId ||
    context.threadId ||
    context.resumedFromRunId ||
    local.tasks.isContinuation(context.runId) ||
    !run ||
    run.kind !== "chat" ||
    run.automatic ||
    run.taskId
  )
    return "reveal_unattended_denied";
  if (
    run.status !== "running" ||
    run.botId !== context.botId ||
    (run.groupId ?? undefined) !== context.groupId ||
    run.conversationId !== context.conversationId ||
    run.messageId !== context.messageId
  )
    return "reveal_not_requested";
  const messages = new MessagesRepo(local.deps.db);
  const reply = messages.get(context.messageId);
  if (
    reply?.role !== "assistant" ||
    reply.botId !== run.botId ||
    reply.conversationId !== run.conversationId ||
    reply.runId !== run.id
  )
    return "reveal_not_requested";
  // Native additions move chatReplyTo with the reply. An automatic follow-up segment deliberately
  // has no user target: do not fall back to an older affirmative request in that case.
  const segmented =
    reply.usage && typeof reply.usage === "object" && Object.hasOwn(reply.usage, "chatReplyTo");
  const sourceId = segmented ? chatReplyTo(reply) : run.userMessageId;
  if (segmented && !sourceId) return "reveal_unattended_denied";
  const source = sourceId ? messages.get(sourceId) : undefined;
  if (
    source?.role !== "user" ||
    source.conversationId !== run.conversationId ||
    (source.id !== run.userMessageId && source.runId !== run.id)
  )
    return "reveal_not_requested";
  return requested(messageVisibleText(source)) ? undefined : REVEAL_CONFIRMATION_REASON;
}
