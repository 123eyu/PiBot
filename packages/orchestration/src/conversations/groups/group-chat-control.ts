import { type UserMessageDisplay, userMessageUsage } from "@pibot/brain/orchestration-kit";
import type { Group, KernelMethodParams, KernelMethodResults } from "@pibot/protocol-base";
import { MessagesRepo, transaction } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

export type ChatControl = "pause" | "resume";

/**
 * Maintainers 2026-11-20: 「先暂停吧」 went to the coordinator, whose todo_pause only paused its own
 * follow-through while the member's plan step kept running. A short message that is clearly a
 * pause or continue now works the group's pause switch itself. Rules only, no model: the whole
 * message must be the command, so anything longer, a question, or one with another instruction
 * stays an ordinary message.
 */
const MAX_CHARS = 30;
const ZH_LEAD = "(?:好的?|好吧|ok|okay|那就?|就|请|麻烦|你们|大家|都|可以)*";
const ZH_TAIL = "(?:一下|一会儿?|下)?先?(?:吧|了|啊|呀|哈|哦|啦|嘛)*";
const ZH_OBJECT = "(?:计划|任务|工作|执行)?";
const ZH_PAUSE_CORE =
  "先?(?:暂停|停下来|停一下|停一停|停下|停止|停手|停|别做了|别干了|别弄了|不要做了|别做|别动了|等一下|等等)";
const zhPhrase = `${ZH_PAUSE_CORE}${ZH_OBJECT}${ZH_TAIL}`;
const ZH_PAUSE = new RegExp(`^${ZH_LEAD}${zhPhrase}(?:${zhPhrase})?$`);
const ZH_RESUME = new RegExp(
  `^${ZH_LEAD}(?:继续做|继续干|继续执行|继续|接着做|接着来|接着干|接着|恢复执行|恢复)${ZH_OBJECT}(?:吧|了|啊|呀|哈|哦|啦|嘛)*$`,
);
const EN_LEAD = "(?:(?:ok|okay|alright|all right|hey|guys|everyone|team|please|pls|let's|lets) )*";
const EN_TAIL = "(?: (?:please|pls|thanks|thank you))?";
const EN_PAUSE_CORE =
  "(?:pause|stop|halt|hold on|hold up|hang on|wait)(?: (?:it|that|everything|all|the plan|the work|work|working|now|here|for now|for a (?:sec|second|moment|minute|bit)|a (?:sec|second|moment|minute|bit)))*";
const EN_PAUSE = new RegExp(`^${EN_LEAD}${EN_PAUSE_CORE}(?: ${EN_PAUSE_CORE})?${EN_TAIL}$`);
const EN_RESUME = new RegExp(
  `^${EN_LEAD}(?:continue|resume|unpause|go on|carry on|keep going|proceed|go ahead)(?: (?:it|the plan|the work|working|now|then))*${EN_TAIL}$`,
);

export function chatControlIntent(text: string): ChatControl | undefined {
  const raw = text.trim().toLowerCase();
  // A question ("暂停了吗？"), a mention or a second line is a conversation, not a command.
  if (!raw || raw.length > MAX_CHARS || /[?？@\n]/.test(raw)) return undefined;
  const zh = raw.replace(/[\s，。,.!！~～、…]+/g, "");
  if (ZH_PAUSE.test(zh)) return "pause";
  if (ZH_RESUME.test(zh)) return "resume";
  const en = raw
    .replace(/[，。,.!！~～…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (EN_PAUSE.test(en)) return "pause";
  if (EN_RESUME.test(en)) return "resume";
  return undefined;
}

/** A fixed program line in the group, posted the way plan progress lines are (no model turn). */
export function postProgramNotice(
  service: GroupService,
  group: Pick<Group, "id" | "conversationId" | "coordinatorBotId">,
  kind: ChatControl,
  stepTitle?: string,
) {
  const zh = service.deps.chat.currentLanguage() === "zh";
  const text =
    kind === "pause"
      ? zh
        ? "已暂停：正在做的步骤已停下，进度保留。说「继续」或点「继续」恢复。"
        : 'Paused: the running step stopped and progress is kept. Say "continue" or tap Continue to resume.'
      : stepTitle
        ? zh
          ? `已继续，从「${stepTitle}」接着做。`
          : `Resumed from "${stepTitle}".`
        : zh
          ? "已继续。"
          : "Resumed.";
  const message = new MessagesRepo(service.deps.db).create({
    conversationId: group.conversationId,
    botId: group.coordinatorBotId,
    role: "assistant",
    content: service.deps.redactor.redact(text),
    status: "done",
    usage: { groupProgramNotice: { kind } },
  });
  service.changed(group.id, "updated");
  return message;
}

/**
 * The pause / continue words of a group's main chat, handled by the program. Returns undefined
 * when the message is not one of them, or when today's handling applies (a pause with nothing
 * running, a continue while not paused); the caller then sends it to the Bots as usual.
 */
export async function chatControl(
  service: GroupService,
  params: KernelMethodParams["chat.send"] & { groupId: string },
  display: UserMessageDisplay | undefined,
) {
  if (
    params.threadId ||
    params.replyToMessageId ||
    params.attachments?.length ||
    params.attachmentIds?.length ||
    params.mentions?.length
  )
    return undefined;
  const intent = chatControlIntent(params.text);
  if (!intent || service.changing(params.groupId)) return undefined;
  const group = service.active(params.groupId, undefined, params.topicId);
  if (params.topicId && params.topicId !== group.conversationId) return undefined;
  const plans = service.workflows.repo.activeForGroup(group.id);
  if (intent === "pause") {
    if (group.paused || (!plans.length && !service.runs.hasActiveAutomatic(group.id)))
      return undefined;
    let userId = "";
    const notice = await pauseGroupNow(service, group, "chat_pause", () => {
      userId = storeUserMessage(service, group.conversationId, params.text, display).id;
    });
    return receipt(service, group, userId, notice.id);
  }
  if (!group.paused) return undefined;
  let userId = "";
  const { notice } = await resumeGroupNow(service, group, "chat_resume", () => {
    userId = storeUserMessage(service, group.conversationId, params.text, display).id;
  });
  return receipt(service, group, userId, notice.id);
}

/**
 * The group's pause, as the header switch does it (cancels automatic runs, records the pause),
 * followed by the program's fixed line. Shared by the chat words and the coordinator's
 * group_pause tool; `between` stores the user's words first so the line answers them.
 */
export async function pauseGroupNow(
  service: GroupService,
  group: Group,
  event: "chat_pause" | "tool_pause",
  between?: () => void,
) {
  const stoppedSteps = service.workflows.repo
    .activeForGroup(group.id)
    .flatMap((plan) => service.workflows.repo.steps(plan.id))
    .filter((step) => step.status === "running").length;
  service.chatPausing.add(group.id);
  try {
    await service.update({ groupId: group.id, paused: true });
  } finally {
    service.chatPausing.delete(group.id);
  }
  between?.();
  const notice = postProgramNotice(service, group, "pause");
  log(service, event, group.id, stoppedSteps, 0);
  return notice;
}

/** Un-pauses and reruns the steps the pause stopped; same line and log as the chat words. */
export async function resumeGroupNow(
  service: GroupService,
  group: Group,
  event: "chat_resume" | "tool_resume",
  between?: () => void,
) {
  service.chatResuming.add(group.id);
  let updated: Group;
  try {
    updated = await service.update({ groupId: group.id, paused: false });
  } finally {
    service.chatResuming.delete(group.id);
  }
  between?.();
  const resumed = service.resumeAfterPause(updated, false);
  const notice = postProgramNotice(service, group, "resume", resumed[0]?.title);
  log(service, event, group.id, 0, resumed.length);
  return { notice, resumed };
}

/** Stored like any user message so the chat and the Bots' later context show it; not dispatched. */
function storeUserMessage(
  service: GroupService,
  conversationId: string,
  text: string,
  display: UserMessageDisplay | undefined,
) {
  return transaction(service.deps.db, () =>
    new MessagesRepo(service.deps.db).create({
      conversationId,
      role: "user",
      content: service.deps.redactor.redact(text),
      status: "done",
      mentions: [],
      ...userMessageUsage(undefined, display),
      markUnread: false,
    }),
  );
}

function receipt(
  service: GroupService,
  group: Pick<Group, "id" | "conversationId">,
  userMessageId: string,
  noticeId: string,
) {
  service.deps.chat.openConversation(group.conversationId);
  // No Bot run answers these words: the program's line is the reply, so it also stands in for
  // the run id (clients only use it to place the reply after the user's bubble).
  return {
    userMessageId,
    assistantMessageId: noticeId,
    runId: noticeId,
    conversationId: group.conversationId,
    groupId: group.id,
    runs: [] as { botId: string; runId: string; assistantMessageId: string }[],
  } satisfies KernelMethodResults["chat.send"];
}

function log(
  service: GroupService,
  event: "chat_pause" | "chat_resume" | "tool_pause" | "tool_resume",
  groupId: string,
  stoppedSteps: number,
  resumedSteps: number,
) {
  service.deps.logger.info(
    JSON.stringify({ module: "groups", event, groupId, stoppedSteps, resumedSteps }),
  );
}
