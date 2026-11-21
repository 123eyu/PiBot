import { GroupPlanCardSchema } from "@pibot/protocol";
import type { GroupSession } from "./session.ts";

export function start(this: GroupSession) {
  this.generation++;
  this.reading = false;
  this.state = {
    ...this.state,
    paging: false,
    sending: false,
    refreshing: false,
    confirmed: !!this.target.draftId,
  };
  this.active = true;
  this.lifetime = new AbortController();
  this.off = [
    this.peer.on("groups.plan.changed", (event) => {
      if (
        !this.active ||
        this.target.threadId ||
        event.groupId !== this.target.groupId ||
        event.conversationId !== this.target.conversationId
      )
        return;
      const existing = this.state.messages.find((message) => message.id === event.messageId);
      if (!existing || this.reading) this.schedule();
      const usage = existing?.usage;
      if (!existing || !usage || typeof usage !== "object" || Array.isArray(usage)) return;
      const previous = GroupPlanCardSchema.safeParse(usage.groupPlan);
      if (
        previous.success &&
        previous.data.id === event.card.id &&
        event.updatedAt >= existing.updatedAt
      ) {
        this.publish({
          messages: this.state.messages.map((message) =>
            message.id === event.messageId
              ? {
                  ...message,
                  usage: { ...usage, groupPlan: event.card },
                  updatedAt: event.updatedAt,
                }
              : message,
          ),
        });
        this.remember();
      }
    }),
    // Program-owned plan cards can change after the coordinator's run has already settled.
    this.peer.on("groups.changed", (event) => {
      if (this.active && event.groupId === this.target.groupId && !this.target.threadId)
        this.schedule();
    }),
    this.peer.on("execution.question.answered", (event) => {
      if (this.active && event.conversationIds.includes(this.target.conversationId))
        this.schedule();
    }),
    this.peer.on("chat.message", (e) => {
      if (!this.active || e.conversationId !== this.target.conversationId) return;
      const existing = this.state.messages.find((m) => m.id === e.messageId);
      if (!existing || this.reading) this.schedule();
      if (
        existing &&
        existing.botId === e.botId &&
        existing.runId === e.runId &&
        e.message.updatedAt >= existing.updatedAt &&
        !(existing.status !== "streaming" && e.message.status === "streaming")
      )
        this.publish({
          messages: this.state.messages.map((m) => (m.id === e.messageId ? e.message : m)),
        });
    }),
    this.peer.on("chat.delta", (e) => {
      if (!this.matches(e)) return;
      const found = this.state.messages.some(
        (m) => m.id === e.messageId && m.runId === e.runId && m.botId === e.botId,
      );
      if (this.reading || !found) {
        if (this.deltas.length < 1000 && this.deltaSize + e.text.length <= 1_000_000) {
          this.deltas.push(e);
          this.deltaSize += e.text.length;
        } else {
          this.deltas = [];
          this.deltaSize = 0;
          this.schedule();
        }
      }
      if (found) this.publish({ messages: this.apply(this.state.messages, e) }, true);
      else this.schedule();
    }),
    this.peer.on("chat.attachments", (e) => {
      if (this.matches(e)) this.schedule();
    }),
    this.peer.on("chat.done", (e) => {
      if (this.matches(e)) {
        this.terminal(
          e,
          ["aborted", "approval_paused"].includes(e.stopReason) ? "aborted" : "done",
        );
        this.schedule();
      }
    }),
    this.peer.on("chat.error", (e) => {
      if (this.matches(e)) {
        this.terminal(e, e.code === "aborted" ? "aborted" : "error", e.code);
        this.schedule();
      }
    }),
    this.peer.on("chat.status", (e) => {
      if (this.matches(e)) {
        if (e.state === "idle") this.terminal(e);
        this.schedule();
      }
    }),
    this.peer.on("chat.tool", (e) => {
      if (this.matches(e) && e.phase === "end") this.schedule();
    }),
    this.peer.on("group.task", (e) => {
      if (
        e.task.groupId === this.target.groupId &&
        e.task.status === "done" &&
        !this.target.threadId
      )
        this.schedule();
    }),
  ];
  void this.refresh();
  return () => {
    this.remember();
    this.active = false;
    this.generation++;
    this.lifetime.abort();
    clearTimeout(this.timer);
    clearTimeout(this.deltaTimer);
    this.timer = undefined;
    this.deltaTimer = undefined;
    for (const unsubscribe of this.off) unsubscribe();
    this.off = [];
    this.deltas = [];
    this.deltaSize = 0;
    this.terminals.clear();
  };
}
