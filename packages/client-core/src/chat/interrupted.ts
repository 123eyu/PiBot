import type { Message } from "@pibot/protocol";
import { interruptedRun, RUN_INTERRUPTED } from "@pibot/protocol";

/** Renderer hint for the reply whose run a restart interrupted. */
export function interruptedMessage(message: Pick<Message, "role" | "status" | "usage">): boolean {
  const usage = message.usage;
  const stopReason =
    usage &&
    typeof usage === "object" &&
    !Array.isArray(usage) &&
    usage.stopReason === RUN_INTERRUPTED
      ? RUN_INTERRUPTED
      : null;
  return message.role === "assistant" && interruptedRun({ status: message.status, stopReason });
}
