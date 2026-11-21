import type { EventPayloads } from "@pibot/protocol";

/**
 * Which computer events become an in-app notification, and when. Pure: no native module,
 * so the dev probe runs it under Node. Content is the Bot or group name plus one fixed phrase —
 * never a message, file name, approval detail, task title or secret (same rule as push).
 */
export type NoticeKind =
  | "approval"
  | "takeover"
  | "reply_done"
  | "reply_failed"
  | "task_done"
  | "task_failed";
export type NoticeRoute =
  | { screen: "approval"; id: string }
  | { screen: "browser"; botId: string; topic?: string }
  | { screen: "chat"; kind: "bot" | "group"; id: string }
  | { screen: "task"; kind: "run" | "routine"; id: string };
export interface Notice {
  /**
   * Event id, shared with the desktop push sender (packages/remote/src/brain/push/notifications.ts):
   * `approval:<approvalId>`, `run_done:<runId>`, `run_failed:<runId>`. One run therefore notifies
   * once, whether its reply, its task or its routine reports the end first, or a push did.
   */
  id: string;
  kind: NoticeKind;
  botId?: string;
  groupId?: string;
  route: NoticeRoute;
  /** The desktop pushes this kind even while the phone is linked (approvals always notify). */
  pushedWhileLinked: boolean;
}
type Handled =
  | "approval.requested"
  | "chat.done"
  | "chat.error"
  | "execution.task.changed"
  | "routine.run";
export const NOTICE_EVENTS: readonly Handled[] = [
  "approval.requested",
  "chat.done",
  "chat.error",
  "execution.task.changed",
  "routine.run",
];
// An old task touched again (archived, verified) must not announce its end a second time.
const RECENT_MS = 10 * 60_000;

const chatRoute = (p: { botId?: string; groupId?: string }): NoticeRoute | undefined =>
  p.groupId
    ? { screen: "chat", kind: "group", id: p.groupId }
    : p.botId
      ? { screen: "chat", kind: "bot", id: p.botId }
      : undefined;

/** Maps one live event to a notice, or undefined when the event is not news for the person. */
export function toNotice<K extends Handled>(
  method: K,
  payload: EventPayloads[K],
  now = Date.now(),
): Notice | undefined {
  switch (method) {
    case "approval.requested": {
      const p = payload as EventPayloads["approval.requested"];
      if (p.status !== "pending") return undefined;
      // A first-login card: the Bot's browser waits for the person to sign in (choose an account
      // or take over). The phone cannot choose accounts, but it can take the browser over.
      if (p.login)
        return {
          id: `approval:${p.id}`,
          kind: "takeover",
          botId: p.botId,
          route: {
            screen: "browser",
            botId: p.botId,
            ...(p.conversationId ? { topic: p.conversationId } : {}),
          },
          pushedWhileLinked: true,
        };
      return {
        id: `approval:${p.id}`,
        kind: "approval",
        botId: p.botId,
        route: { screen: "approval", id: p.id },
        pushedWhileLinked: true,
      };
    }
    case "chat.done":
    case "chat.error": {
      const p = payload as EventPayloads["chat.done"] | EventPayloads["chat.error"];
      // The person stopped it themselves; a group task thread reports through the group instead.
      if ("code" in p && p.code === "aborted") return undefined;
      if ("stopReason" in p && p.stopReason === "aborted") return undefined;
      const route = chatRoute(p);
      if (p.threadId || !route) return undefined;
      const failed = method === "chat.error";
      return {
        id: `${failed ? "run_failed" : "run_done"}:${p.runId}`,
        kind: failed ? "reply_failed" : "reply_done",
        ...(p.botId ? { botId: p.botId } : {}),
        ...(p.groupId ? { groupId: p.groupId } : {}),
        route,
        pushedWhileLinked: false,
      };
    }
    case "execution.task.changed": {
      const p = payload as EventPayloads["execution.task.changed"];
      const failed = p.status === "error" || p.status === "interrupted";
      if ((p.status !== "done" && !failed) || p.archivedAt || p.deletedAt) return undefined;
      if (now - Date.parse(p.updatedAt) > RECENT_MS) return undefined;
      const end = failed ? "run_failed" : "run_done";
      return {
        id: p.runId ? `${end}:${p.runId}` : `task_${failed ? "failed" : "done"}:${p.id}`,
        kind: failed ? "task_failed" : "task_done",
        botId: p.botId,
        route: p.runId
          ? { screen: "task", kind: "run", id: p.runId }
          : { screen: "chat", kind: "bot", id: p.botId },
        pushedWhileLinked: false,
      };
    }
    case "routine.run": {
      const p = payload as EventPayloads["routine.run"];
      const failed = p.status === "failed" || p.status === "timeout";
      if (p.status !== "done" && !failed) return undefined;
      const end = failed ? "run_failed" : "run_done";
      return {
        id: p.runId ? `${end}:${p.runId}` : `routine_${end}:${p.routineRunId}`,
        kind: failed ? "task_failed" : "task_done",
        botId: p.botId,
        route: { screen: "task", kind: "routine", id: p.routineRunId },
        pushedWhileLinked: false,
      };
    }
  }
  return undefined;
}

export interface NoticeContext {
  /** The 通知 switch for this computer (default on). */
  enabled: boolean;
  /** The encrypted link to the computer is up; nothing arrives otherwise. */
  linked: boolean;
  /** App on screen; false during the 30-second background grace. */
  foreground: boolean;
  /** What the person is looking at, when foreground. */
  screen?: NoticeRoute;
  /** The computer holds this phone's Expo push token. */
  pushRegistered: boolean;
  seen(id: string): boolean;
}
export type Decision = "show" | "disabled" | "offline" | "duplicate" | "on_screen" | "push_covers";
const sameScreen = (a: NoticeRoute, b: NoticeRoute | undefined) =>
  !!b &&
  a.screen === b.screen &&
  (a.screen === "browser"
    ? a.botId === (b as typeof a).botId
    : a.screen === "approval"
      ? a.id === (b as typeof a).id
      : a.kind === (b as typeof a).kind && a.id === (b as typeof a).id);

export function decide(notice: Notice, ctx: NoticeContext): Decision {
  if (!ctx.enabled) return "disabled";
  if (!ctx.linked) return "offline";
  if (ctx.seen(notice.id)) return "duplicate";
  // Nothing for the chat (or approval, task, browser) already open in front of the person.
  if (ctx.foreground && sameScreen(notice.route, ctx.screen)) return "on_screen";
  // In the background the system shows the computer's push itself; a local copy would double it.
  if (!ctx.foreground && notice.pushedWhileLinked && ctx.pushRegistered) return "push_covers";
  return "show";
}

export type NoticeTextKey =
  | "noticeApproval"
  | "noticeTakeover"
  | "noticeReplyDone"
  | "noticeReplyFailed"
  | "noticeTaskDone"
  | "noticeTaskFailed";
const bodies: Record<NoticeKind, NoticeTextKey> = {
  approval: "noticeApproval",
  takeover: "noticeTakeover",
  reply_done: "noticeReplyDone",
  reply_failed: "noticeReplyFailed",
  task_done: "noticeTaskDone",
  task_failed: "noticeTaskFailed",
};
/** Title = the Bot (or group) name only; body = one fixed phrase. Nothing from the event itself. */
export function noticeText(
  notice: Notice,
  names: { bot(id: string): string | undefined; group(id: string): string | undefined },
  text: (key: NoticeTextKey) => string,
) {
  const title =
    (notice.groupId && names.group(notice.groupId)) ||
    (notice.botId && names.bot(notice.botId)) ||
    "Pi Bot";
  return { title, body: text(bodies[notice.kind]) };
}
