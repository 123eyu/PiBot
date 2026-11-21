import type { MobileKey } from "../../i18n/messages.ts";
import type { Caller } from "../chat/controls/scope.ts";
import type { ChatRun, RecordRow } from "./model.ts";

/** Where 打开那段对话 goes: a DM or group, the topic, and the message to scroll to. */
export interface RecordTarget {
  kind: "bot" | "group";
  id: string;
  topic?: string;
  focus?: string;
}
export type TargetResult = { target: RecordTarget } | { notice: MobileKey };
export interface TargetContext {
  c: Caller;
  online: boolean;
  rows: readonly RecordRow[];
  /** The conversation row on the phone; absent when the Bot is archived or the group deleted. */
  exists(kind: "bot" | "group", id: string): boolean;
  /** Topic IDs of a DM or group (computer when online, the phone's copy offline). */
  topics(kind: "bot" | "group", id: string, signal: AbortSignal): Promise<string[] | undefined>;
}
interface Place {
  kind: "bot" | "group";
  id: string;
  conversationId: string;
  focus?: string;
  /** A group task thread: not a topic the phone can open, so the group's chat opens instead. */
  thread?: boolean;
}

const runPlace = (run: ChatRun): Place =>
  run.groupId
    ? {
        kind: "group",
        id: run.groupId,
        conversationId: run.conversationId,
        focus: run.messageId,
        thread: !!run.taskId,
      }
    : { kind: "bot", id: run.botId, conversationId: run.conversationId, focus: run.messageId };
function cachedRun(rows: readonly RecordRow[], runId: string) {
  for (const row of rows) if (row.type === "chat" && row.run.id === runId) return row.run;
}
/** The run ledger names a run's conversation even when the phone has not cached it. */
async function findRun(context: TargetContext, botId: string, runId: string, signal: AbortSignal) {
  const cached = cachedRun(context.rows, runId);
  if (cached || !context.online) return cached;
  let before: string | undefined;
  for (let page = 0; page < 3; page++) {
    const runs = await context.c.call(
      "chat.runs",
      { botId, limit: 100, ...(before ? { before } : {}) },
      signal,
    );
    const run = runs.find((item) => item.id === runId);
    if (run) return run;
    // The computer returns only the last 3 days to a phone; a short page is the end.
    if (runs.length < 100) return undefined;
    before = runs.at(-1)?.id;
  }
}
async function placeOf(row: RecordRow, context: TargetContext, signal: AbortSignal) {
  switch (row.type) {
    case "chat":
      return runPlace(row.run);
    case "routine": {
      const run = row.run;
      // As on the desktop: a deleted task's topic is gone with it; a trial keeps its own.
      const locatable =
        !!run.conversationId &&
        !!run.triggerMessageId &&
        (run.reason === "trial" || (!!run.routineId && !!run.taskName && !run.taskDeleted));
      return locatable
        ? {
            kind: "bot" as const,
            id: run.botId,
            conversationId: run.conversationId as string,
            focus: run.triggerMessageId as string,
          }
        : undefined;
    }
    case "command": {
      const command = row.command;
      if (!command.place || !command.conversationId) return undefined;
      const focus = cachedRun(context.rows, command.runId)?.messageId;
      return {
        kind: command.groupId ? ("group" as const) : ("bot" as const),
        id: command.groupId ?? command.botId,
        conversationId: command.conversationId,
        ...(focus ? { focus } : {}),
        thread: command.place.kind === "thread",
      };
    }
    case "audit": {
      if (!row.entry.runId) return undefined;
      const run = await findRun(context, row.entry.botId, row.entry.runId, signal);
      return run ? runPlace(run) : undefined;
    }
  }
}
/**
 * Mirrors the desktop records page's 打开那段对话: the run's own conversation and message. A
 * Bot, group or topic that no longer exists gives a notice instead of a wrong chat.
 */
export async function resolveRecordTarget(
  row: RecordRow,
  context: TargetContext,
  signal: AbortSignal,
): Promise<TargetResult> {
  if (
    row.type === "audit" &&
    row.entry.runId &&
    !context.online &&
    !cachedRun(context.rows, row.entry.runId)
  )
    return { notice: "recordOpenOffline" };
  const place = await placeOf(row, context, signal);
  signal.throwIfAborted();
  if (!place) return { notice: "recordChatGone" };
  if (!context.exists(place.kind, place.id))
    return { notice: place.kind === "bot" ? "recordBotGone" : "recordGroupGone" };
  const topics = await context.topics(place.kind, place.id, signal);
  signal.throwIfAborted();
  if (!topics) return { notice: "recordOpenOffline" };
  if (topics.includes(place.conversationId))
    return {
      target: {
        kind: place.kind,
        id: place.id,
        topic: place.conversationId,
        ...(place.focus ? { focus: place.focus } : {}),
      },
    };
  // A group task thread has no phone view; its group's chat is the nearest place.
  if (place.thread) return { target: { kind: place.kind, id: place.id } };
  return { notice: "recordTopicGone" };
}
