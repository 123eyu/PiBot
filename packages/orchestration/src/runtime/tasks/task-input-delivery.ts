import type { LocalService, RunQueue } from "@pibot/brain/orchestration-kit";
import { RpcError, type TaskSummary } from "@pibot/protocol-base";
import { MessagesRepo, type TaskRepo, transaction } from "@pibot/storage";

/** Durable input receipts are separate from SDK delivery and from a task's execution state. */
export class TaskInputDelivery {
  private readonly deliveries = new Map<string, Promise<boolean>>();
  private readonly initial = new Map<string, { taskId: string; ids: Set<string> }>();
  constructor(
    private readonly local: LocalService,
    private readonly repo: TaskRepo,
    private readonly queue: () => RunQueue,
  ) {}
  capturePrompt(runId: string, taskId: string, ids: string[]) {
    this.initial.set(runId, { taskId, ids: new Set(ids) });
  }
  promptStarted(runId: string) {
    const initial = this.initial.get(runId);
    if (!initial) return;
    transaction(this.local.deps.db, () => {
      for (const id of initial.ids) this.repo.inputs.delivered(initial.taskId, id);
    });
    this.initial.delete(runId);
  }
  release(runId: string) {
    this.initial.delete(runId);
  }
  async message(task: TaskSummary, requestId: string, message: string) {
    const pending = this.repo.inputs.pending(task.id),
      redacted = this.local.deps.redactor.redact(message);
    let existing = this.repo.inputs.get(task.id, requestId);
    if (existing && existing.text !== redacted)
      throw new RpcError(-32602, "task_input_identity_changed");
    if (existing?.delivered) return { task, delivery: "delivered" as const };
    if (!["queued", "running"].includes(task.status))
      throw new RpcError(-32602, "task_not_accepting_input");
    if (
      !existing &&
      (pending.length >= 100 ||
        pending.reduce((sum, item) => sum + item.text.length, 0) + redacted.length > 16_000)
    )
      throw new RpcError(-32011, "task_input_full");
    if (!existing) {
      transaction(this.local.deps.db, () => {
        const internal = this.repo.internal(task.id);
        if (!internal) throw new RpcError(-32602, "task_unavailable");
        const user = new MessagesRepo(this.local.deps.db).create({
          conversationId: internal.conversationId,
          runId: task.runId,
          role: "user",
          content: redacted,
          status: "done",
          markUnread: false,
          usage: { executionTaskInput: true },
        });
        this.repo.inputs.insert(task.id, requestId, user.id, redacted);
      });
      existing = this.repo.inputs.get(task.id, requestId);
    }
    if (!existing) throw new RpcError(-32602, "task_input_unavailable");
    // A retried input already included in the first prompt must not also become a steer.
    if (task.status === "queued" || this.initial.get(task.runId ?? "")?.ids.has(requestId))
      return { task, delivery: "queued" as const };
    const key = `${task.id}:${requestId}`,
      messageId = existing.messageId;
    let delivery = this.deliveries.get(key);
    if (!delivery) {
      const messages = new MessagesRepo(this.local.deps.db),
        user = messages.get(messageId);
      messages.update(messageId, {
        usage: { chatAddition: { requestId: messageId, mode: "steer", state: "queued" } },
      });
      delivery = (
        task.runId
          ? this.queue().appendTask(task.runId, messageId, redacted)
          : Promise.resolve(false)
      )
        .then((accepted) => {
          if (accepted) this.repo.inputs.delivered(task.id, requestId);
          else messages.update(messageId, { usage: user?.usage ?? null });
          return accepted;
        })
        .finally(() => this.deliveries.delete(key));
      this.deliveries.set(key, delivery);
    }
    const accepted = await delivery;
    return {
      task: this.repo.get(task.id) ?? task,
      delivery: accepted ? ("delivered" as const) : ("deferred" as const),
    };
  }
}
