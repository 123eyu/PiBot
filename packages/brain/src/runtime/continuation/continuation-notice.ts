import { ChatNoticesRepo } from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";

export type ContinuationStopCode =
  | "round_limit"
  | "no_progress"
  | "authority_narrowed"
  | "restart_dropped";

export function noteAttachmentDeliveryMissing(
  local: LocalService,
  input: { conversationId: string; botId: string; runId: string },
) {
  try {
    const notice = new ChatNoticesRepo(local.deps.db).addAttachmentDeliveryMissing(input);
    local.deps.peer.emit("chat.notice", notice);
  } catch (error) {
    local.deps.logger.warn(
      `Attachment delivery notice not stored run=${input.runId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

/**
 * The topic itself says that its automatic follow-ups stopped, next to the audit row. A
 * chat record, not a message: no model context, search, export or unread count ever sees it.
 */
export function noteContinuationStopped(
  local: LocalService,
  input: {
    conversationId: string;
    botId: string;
    root: string;
    reasonCode: ContinuationStopCode;
    used: number;
  },
) {
  try {
    const notice = new ChatNoticesRepo(local.deps.db).addContinuationStopped({
      conversationId: input.conversationId,
      botId: input.botId,
      runId: input.root,
      reasonCode: input.reasonCode,
      used: input.used,
    });
    local.deps.peer.emit("chat.notice", notice);
  } catch (error) {
    // The audit row already records the stop; a topic deleted in the meantime must not fail the
    // dispatch or restore path that only wanted to tell the user.
    local.deps.logger.warn(
      `Continuation notice not stored root=${input.root} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}
