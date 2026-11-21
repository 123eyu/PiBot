import type { EventPayloads, Message } from "@pibot/protocol";

/** Both chat controllers consume the same native reply boundary, including buffered deltas. */
export function appendReplyDelta(message: Message, delta: EventPayloads["chat.delta"]): Message {
  const usage = message.usage;
  return {
    ...message,
    content: message.content + delta.text,
    ...(delta.newReply
      ? {
          usage: {
            ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
            progressTextStart: message.content.length,
          },
        }
      : {}),
  };
}

/** A lagging history read must keep the boundary paired with the live text it retains. */
export function preserveLiveReply(snapshot: Message, live: Message): Message {
  const current = live.usage;
  const usage = snapshot.usage;
  return {
    ...snapshot,
    content: live.content,
    ...(current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    typeof current.progressTextStart === "number"
      ? {
          usage: {
            ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
            progressTextStart: current.progressTextStart,
          },
        }
      : {}),
  };
}
