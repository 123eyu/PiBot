import { MessagesRepo } from "@pibot/storage";
import { planFilenameRequest } from "./group-plan-filenames.ts";
import type { GroupService } from "./group-service.ts";

/** Only the anchored request and this coordinator's reply can tighten admission. */
export function confirmationRequested(text: string): boolean {
  // Remove only the negated requirement, so a later affirmative clause still gates admission.
  const affirmative = text.replace(
    /(?:不需要|无需|不必|不用|不需|无须)\s*(?:(?:先|再)?(?:等(?:待)?|经(?:过)?)\s*)?(?:(?:我|你|您|用户)(?:的)?\s*)?(?:再次\s*)?(?:确认|批准|同意)|\b(?:(?:do\s+not|don['’]t|does\s+not|doesn['’]t)\s+(?:need|require|wait|await)|no\s+need|without)\s+(?:(?:to|for|wait|waiting|await|until|my|your|user|the|I|you|a|any|explicit|prior|additional)\s+){0,10}(?:confirmation|approval|consent|confirm|approve|review)\b/giu,
    " ",
  );
  return /(?:等|待|经|需要|须|需|让我|由我|请我)[^。！？\n]{0,24}(?:确认|批准|同意)|(?:确认|批准|同意)[^。！？\n]{0,16}(?:再|才|之后|后)[^。！？\n]{0,12}(?:开始|执行|运行)|先[^。！？\n]{0,12}(?:看|审阅)[^。！？\n]{0,12}计划|\b(?:wait for|await|require|need)\b[^.!?\n]{0,50}\b(?:confirmation|approval|consent)\b|\b(?:confirm|approve|review)\b[^.!?\n]{0,30}\b(?:before|first)\b|\buntil\s+(?:I|you)\s+(?:confirm|approve)\b/iu.test(
    affirmative,
  );
}

export function planConfirmationRequired(
  service: GroupService,
  runId: string,
  currentReply?: string,
): boolean {
  const run = service.runs.get(runId);
  if (!run?.groupId) return false;
  const messages = new MessagesRepo(service.deps.db);
  const root = service.runs.get(service.deps.local.tasks.budgetRoot(run));
  const request = root?.userMessageId ? messages.get(root.userMessageId) : undefined;
  const group = service.groups.get(run.groupId);
  const reply = messages.get(run.messageId);
  return (
    confirmationRequested(currentReply ?? "") ||
    (request?.role === "user" &&
      request.conversationId === group?.conversationId &&
      confirmationRequested(request.content)) ||
    confirmationRequested(planFilenameRequest(service, runId)) ||
    (reply?.role === "assistant" &&
      reply.botId === run.botId &&
      reply.conversationId === run.conversationId &&
      confirmationRequested(reply.content))
  );
}
