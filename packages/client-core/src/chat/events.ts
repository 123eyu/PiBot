// Chat events update the active topic and reconcile missing live rows with persisted history.
import { chatReplyTo } from "@pibot/protocol";
import { appendReplyDelta, preserveLiveReply } from "./reply-delta.ts";
import type { ChatSession } from "./session.ts";
import type { ChatEvent } from "./types.ts";

export function receive(this: ChatSession, event: ChatEvent) {
  if (!this.matches(event.payload)) return;
  // no_model has temporary UUIDs and no corresponding persisted message.
  if (event.kind === "error" && event.payload.code === "no_model") return;
  if (this.state.pending) {
    const size =
      event.kind === "delta"
        ? event.payload.text.length
        : event.kind === "message"
          ? event.payload.message.content.length
          : 0;
    if (this.earlyEvents.length < 1000 && this.earlySize + size <= 2_000_000) {
      this.earlyEvents.push(event);
      this.earlySize += size;
    } else this.historyRefreshPending = true;
    return;
  }
  this.applyEvent(event);
}

export function applyEvent(this: ChatSession, event: ChatEvent) {
  const { messageId, runId } = event.payload;
  if (
    !this.state.conversationId &&
    !this.target.topicId &&
    !this.state.messages.some((message) => message.runId === runId)
  )
    return;
  if (event.kind === "message") {
    const message = event.payload.message;
    if (
      !this.matches(event.payload) ||
      message.id !== messageId ||
      message.runId !== runId ||
      message.conversationId !== event.payload.conversationId
    )
      return;
    const index = this.state.messages.findIndex((item) => item.id === messageId);
    const existing = this.state.messages[index];
    const updated =
      message.status === "streaming" && existing ? preserveLiveReply(message, existing) : message;
    this.patch({
      messages:
        index < 0
          ? [...this.state.messages, updated]
          : this.state.messages.map((item) => (item.id === messageId ? updated : item)),
    });
    return;
  }
  if (!this.matches(event.payload)) return;
  if (!this.state.messages.some((m) => m.id === messageId && m.runId === runId)) {
    // A split reply can finish before its row reaches this viewport. Its terminal event
    // still gives us a chance to recover committed attachments from the current topic.
    if (event.kind !== "delta") void this.refreshHistory();
    return;
  }
  this.patch(
    {
      messages: this.state.messages.map((message) => {
        if (message.id !== messageId || message.runId !== runId) return message;
        if (event.kind === "delta")
          return message.status === "streaming"
            ? appendReplyDelta(message, event.payload)
            : message;
        if (event.kind === "attachments")
          return { ...message, attachments: event.payload.attachments };
        if (event.kind === "done") {
          const previous = message.usage;
          const usage = event.payload.usage;
          const inputId = chatReplyTo(message);
          return {
            ...message,
            status: ["aborted", "approval_paused"].includes(event.payload.stopReason)
              ? "aborted"
              : "done",
            usage:
              previous && typeof previous === "object" && !Array.isArray(previous)
                ? {
                    ...previous,
                    ...(usage && typeof usage === "object" && !Array.isArray(usage)
                      ? usage
                      : { usage: usage ?? null }),
                    ...(inputId ? { chatReplyTo: inputId } : {}),
                  }
                : (usage ?? null),
          };
        }
        return {
          ...message,
          status: event.payload.code === "aborted" ? "aborted" : "error",
          errorCode: event.payload.code,
        };
      }),
    },
    event.kind === "delta",
  );
  if (event.kind !== "delta" && event.kind !== "attachments") {
    this.patch({ stopping: false });
    void this.refreshHistory();
    // A finished turn may have been compacted first, so the notice must re-ask instead of
    // staying up until the next reload.
    if (event.kind === "done") void this.checkContextHint();
  }
}
