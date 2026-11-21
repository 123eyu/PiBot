import type { ComputerRunContext } from "@pibot/brain/kit";
import { auditText } from "@pibot/brain/kit";
import type {
  ComputerApp,
  ComputerFailure,
  ComputerFailureCode,
  ComputerHandoffMessage,
  ComputerHandoffNotice,
} from "@pibot/computer-use-contract/full";
import { RpcError } from "@pibot/computer-use-contract/full";
import { ChatNoticesRepo, ConversationsRepo, SidebarRepo } from "@pibot/storage";

import type { ComputerContext } from "../../context.ts";
import { COMPUTER_RETRY_LIMIT } from "./computer-retry-guard.ts";

/** How a card ended, from the run's point of view. */
export type HandoffAnswer = "continue" | "decline" | "timeout" | "cancelled";

// Failures the Bot can get past itself (open_app, read again), that another card already covers
// (foreground step), or that are refusals rather than something the user can fix.
const NEVER = new Set<ComputerFailureCode>([
  "app_not_running",
  "stale_element",
  "stale_screenshot",
  "target_moved",
  "needs_foreground",
  "cancelled",
  "app_blocked",
  "app_not_granted",
]);
const CHAT_WAIT_MS = 10 * 60_000;
const ROUTINE_WAIT_MS = 24 * 60 * 60_000;

/**
 * Whether this failure, the `count`-th identical one in a row (computer-retry-guard's
 * streak), asks the user to come and help, and with which sentence. Permissions on the first
 * failure, windows on the second, anything else at the retry limit.
 */
export function handoffMessage(
  failure: Pick<ComputerFailure, "code" | "detail">,
  count: number,
): ComputerHandoffMessage | undefined {
  if (NEVER.has(failure.code)) return undefined;
  const detail = failure.detail ?? "";
  if (failure.code === "permission_missing") {
    const permission = detail.startsWith("screen_recording_not_effective")
      ? "screen_recording_not_effective"
      : detail.startsWith("screen_recording")
        ? "screen_recording"
        : /accessibility|not_trusted/.test(detail)
          ? "accessibility"
          : undefined;
    // A permission the hint does not name falls back to the retry limit below.
    if (permission) return permission;
  } else if (failure.code === "window_not_found") {
    if (count < 2) return undefined;
    if (detail.startsWith("app_has_no_open_window")) return "open_window";
    if (detail.startsWith("window_minimized")) return "window_minimized";
    if (detail.startsWith("window_on_other_space")) return "window_other_space";
    if (detail.startsWith("window_covered_by_other_windows")) return "window_covered";
    return "window_other";
  }
  return count >= COMPUTER_RETRY_LIMIT ? "retry_limit" : undefined;
}

/** Permission cards are about Pi Bot itself, so declining one covers every app in the run. */
export function declinedKey(message: ComputerHandoffMessage, app: ComputerApp) {
  return ["accessibility", "screen_recording", "screen_recording_not_effective"].includes(message)
    ? message
    : `${message}\u0000${app.id.toLowerCase()}`;
}

interface Waiter {
  context: ComputerRunContext;
  settle(answer: HandoffAnswer): void;
}

/**
 * "Come help for a moment" cards: one open card per run, shown in the chat (a chat notice)
 * and in the inbox, waiting like an approval (10 min in chat, the routine's wait otherwise). The
 * card asks for real human action. YOLO reports the missing prerequisite without waiting.
 * Owner: ComputerContext (`dispose` closes open cards; `recover` closes those of a stopped brain).
 */
export class ComputerHandoffService {
  private readonly repo: ChatNoticesRepo;
  private readonly waiting = new Map<string, Waiter>();
  private readonly runs = new Set<string>();

  constructor(
    private readonly local: ComputerContext,
    /** Probe / test override of both waits. */
    private readonly waitMs?: number,
  ) {
    this.repo = new ChatNoticesRepo(local.deps.db);
  }

  isIdle() {
    return this.waiting.size === 0;
  }

  /**
   * Whether a card can be shown for this run now: it needs a live conversation to appear in, and
   * a run already waiting on a card shows no second one.
   */
  available(context: ComputerRunContext) {
    if (this.runs.has(context.runId) || !context.conversationId) return false;
    const conversation = new ConversationsRepo(this.local.deps.db).get(context.conversationId);
    return !!conversation && !conversation.archivedAt;
  }

  /** Cards left open when the brain stopped: their runs are gone, so they read as cancelled. */
  recover() {
    try {
      for (const notice of this.repo.cancelOpenHandoffs())
        this.audit(notice, { handoff: "cancelled", actor: "system", durationMs: 0 });
    } catch {
      this.local.deps.logger.warn("Computer handoff recovery failed");
    }
  }

  /**
   * Shows the card and waits for the answer. Undefined when no card can be shown (no
   * conversation to show it in, or this run already has one open): the step simply fails.
   */
  async ask(
    context: ComputerRunContext,
    input: {
      tool: string;
      app: ComputerApp;
      failure: ComputerFailure;
      message: ComputerHandoffMessage;
    },
    signal: AbortSignal,
  ): Promise<HandoffAnswer | undefined> {
    const { deps } = this.local;
    if (!this.available(context) || !context.conversationId) return undefined;
    if (signal.aborted) return "cancelled";
    if (this.local.isYolo(context)) {
      this.local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "computer.handoff",
        summary: "Human action required / 需要人工操作",
        detail: {
          actor: "automatic",
          reasonCode: "needs_user_action",
          toolName: input.tool,
          category: "computer",
          target: auditText(input.app.id, deps.redactor),
        },
      });
      return undefined;
    }
    const conversation = new ConversationsRepo(deps.db).get(context.conversationId);
    if (!conversation) return undefined;
    const wait =
      this.waitMs ??
      (context.routineRunId ? (context.routineApprovalWaitMs ?? ROUTINE_WAIT_MS) : CHAT_WAIT_MS);
    const notice = this.repo.addHandoff({
      conversationId: conversation.id,
      botId: context.botId,
      runId: context.runId,
      tool: input.tool,
      app: input.app,
      code: input.failure.code,
      ...(input.failure.detail ? { detail: input.failure.detail.slice(0, 500) } : {}),
      message: input.message,
      platform: deps.platform,
      expiresAt: new Date(Date.now() + wait).toISOString(),
    });
    this.runs.add(context.runId);
    this.audit(notice, { handoff: "shown", actor: "system" });
    const started = Date.now();
    context.routineClock?.pause("computer_handoff");
    context.executionClock?.pause("computer_handoff");
    try {
      this.announce(notice, conversation.groupId ? `group:${conversation.groupId}` : undefined);
      const answer = await new Promise<HandoffAnswer>((resolve) => {
        let unsubscribe = () => {};
        const settle = (value: HandoffAnswer) => {
          clearTimeout(timer);
          unsubscribe();
          signal.removeEventListener("abort", abort);
          this.waiting.delete(notice.id);
          resolve(value);
        };
        const abort = () => settle("cancelled");
        const timer = setTimeout(() => settle("timeout"), wait);
        signal.addEventListener("abort", abort, { once: true });
        this.waiting.set(notice.id, { context, settle });
        const source = context.executionTaskId ? this.local.source(context) : context;
        unsubscribe = this.local.onYoloEnabled(source.conversationId ?? conversation.id, () => {
          if (this.local.isYolo(context)) settle("cancelled");
        });
        if (signal.aborted) abort();
        else if (this.local.isYolo(context)) settle("cancelled");
      });
      this.close(notice, answer, Date.now() - started);
      return answer;
    } finally {
      this.runs.delete(context.runId);
      context.routineClock?.resume("computer_handoff");
      context.executionClock?.resume("computer_handoff");
    }
  }

  /** `computer.handoff.resolve` from the chat card or the inbox. */
  resolve(id: string, action: "continue" | "decline") {
    const waiter = this.waiting.get(id);
    if (!waiter) throw new RpcError(-32602, "computer_handoff_closed");
    waiter.settle(action);
  }

  /** The user stopped this run's computer control: a "come help" card has nothing to wait for. */
  cancelRun(runId: string) {
    for (const waiter of [...this.waiting.values()])
      if (waiter.context.runId === runId) waiter.settle("cancelled");
  }

  dispose() {
    for (const waiter of [...this.waiting.values()]) waiter.settle("cancelled");
  }

  private announce(notice: ComputerHandoffNotice, groupKey: string | undefined) {
    const { deps } = this.local;
    deps.peer.emit("chat.notice", notice);
    deps.peer.emit("inbox.changed", {});
    try {
      // Same unread mark an approval card leaves, so the conversation stands out in the sidebar.
      const conversationKey = groupKey ?? `dm:${notice.botId}`;
      new SidebarRepo(deps.db).activity(conversationKey, true);
      deps.peer.emit("sidebar.changed", { conversationKey });
    } catch {
      // The card is already in the chat and the inbox; the sidebar mark is a convenience.
      deps.logger.warn(`Computer handoff sidebar mark failed bot=${notice.botId}`);
    }
  }

  private close(notice: ComputerHandoffNotice, answer: HandoffAnswer, durationMs: number) {
    const status = answer === "continue" ? "continued" : answer === "decline" ? "declined" : answer;
    const closed = this.repo.closeHandoff(notice.id, status);
    // Already closed elsewhere (a restarted brain cancelled it): that close was audited there.
    if (!closed) return;
    this.audit(notice, {
      handoff: status,
      actor: answer === "continue" || answer === "decline" ? "user" : "automatic",
      durationMs: Math.max(0, Math.round(durationMs)),
    });
    this.local.deps.peer.emit("chat.notice", closed);
    this.local.deps.peer.emit("inbox.changed", {});
  }

  /** Audit facts only: failure code and hint, app id, the choice and the wait. */
  private audit(
    notice: ComputerHandoffNotice,
    detail: {
      handoff: "shown" | "continued" | "declined" | "timeout" | "cancelled";
      actor: "user" | "automatic" | "system";
      durationMs?: number;
    },
  ) {
    const { redactor } = this.local.deps;
    this.local.approvals.audit.append({
      botId: notice.botId,
      runId: notice.runId,
      kind: "computer.handoff",
      summary:
        detail.handoff === "shown"
          ? "Asked the user to help with a computer step / 请用户来处理操作电脑的一步"
          : `Computer step help ${detail.handoff} / 请用户处理的一步已结束`,
      detail: {
        category: "computer",
        toolName: notice.tool,
        target: auditText(notice.app.id, redactor),
        reasonCode: notice.code,
        ...(notice.detail ? { reason: auditText(notice.detail, redactor) } : {}),
        ...detail,
      },
    });
  }
}
