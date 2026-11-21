import type { Message } from "@pibot/protocol";

/** A server fact, with display-side checks so content never disappears behind a stale marker. */
export function silentWake(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.status === "aborted" &&
    !message.content.trim() &&
    !message.attachments?.length &&
    !message.tools?.length &&
    !!message.usage &&
    typeof message.usage === "object" &&
    !Array.isArray(message.usage) &&
    message.usage.silentWake === true
  );
}
