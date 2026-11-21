import type { QueueInput } from "@pibot/brain/orchestration-kit";
import { collaborationAuditFields, continuationKey } from "@pibot/brain/orchestration-kit";
import { type Group, RpcError } from "@pibot/protocol-base";
import { BotsRepo, MessagesRepo, transaction } from "@pibot/storage";
import { sendBack, stopUnmet } from "./group-handoff-actions.ts";
import type { GroupService } from "./group-service.ts";

/** Completion notifications survive capacity pressure; queued prompts are never replayed. */
export class GroupWakes {
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private cursor = "";
  constructor(private readonly service: GroupService) {}
  start() {
    this.interval = setInterval(() => this.schedule(), 5_000);
    this.interval.unref();
    this.schedule();
  }
  schedule() {
    if (this.closed || !this.service.interactive || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 0);
    this.timer.unref();
  }
  private flush() {
    if (this.closed || !this.service.interactive) return;
    try {
      const page = this.service.cycles.pendingWakes(this.cursor);
      for (const id of page) {
        try {
          this.enqueue(id);
        } catch {
          this.service.deps.logger.warn(`Group completion wake retained task=${id}`);
        }
      }
      this.cursor = page.length === 50 ? (page.at(-1) ?? "") : "";
      // Yield between bounded pages; exhausted/full queues wait for capacity or the retry timer.
      if (this.cursor) this.schedule();
    } catch {
      this.cursor = "";
      this.service.deps.logger.warn("Group completion wake scan deferred");
    }
  }
  enqueue(taskId: string): { runId?: string; reason?: string } {
    if (this.closed || !this.service.interactive) return { reason: "stopping" };
    const { service } = this;
    const task = service.tasks.get(taskId),
      origin = service.cycles.origin(taskId);
    if (task?.status !== "done" || !origin?.finishedRunId) return { reason: "not_completed" };
    if (service.memberWorktrees.blocksWake(task.id))
      return { reason: "workspace_integration_pending" };
    const finished = service.runs.get(origin.finishedRunId);
    const key = continuationKey(
      "task-done",
      finished ? service.deps.local.tasks.budgetRoot(finished) : origin.finishedRunId,
      task.id,
    );
    if (origin.wakeClaimed) return { runId: service.runs.trigger(key)?.id };
    if (service.changing(task.groupId)) return { reason: "group_changing" };
    let group: Group;
    try {
      group = service.active(task.groupId);
    } catch (error) {
      if (error instanceof RpcError) return { reason: "group_unavailable" };
      throw error;
    }
    if (service.cycles.get(group.id).cycleId !== origin.cycleId) return { reason: "stale" };
    if (group.paused) return { reason: "paused" };
    // A hand-off is judged by the program before the coordinator is woken.
    const gate = service.handoffs.gate(task, origin.finishedRunId);
    if (gate.kind === "wait") return { reason: "checking" };
    if (gate.kind !== "plain" && service.workflows.handleGate(task.id, gate, origin.finishedRunId))
      return { reason: "workflow_scheduled" };
    const facts = { ...origin, finishedRunId: origin.finishedRunId };
    if (gate.kind === "return") return sendBack(service, task, gate.record, facts);
    if (gate.kind === "stop") return stopUnmet(service, task, gate.record, facts);
    try {
      service.deps.chat.queue.capacity([group.coordinatorBotId]);
    } catch (error) {
      if (error instanceof RpcError && error.code === -32011) return { reason: "queue_full" };
      throw error;
    }
    const bot = new BotsRepo(service.deps.db).get(group.coordinatorBotId);
    if (!bot || bot.archivedAt) return { reason: "coordinator_unavailable" };
    const source = new MessagesRepo(service.deps.db).get(origin.sourceMessageId);
    if (
      source?.role === "user" &&
      (source.mentions?.length ?? 0) > 1 &&
      source.mentions?.includes(bot.id) &&
      service.runs.userReply(group.id, source.id, bot.id)
    ) {
      transaction(service.deps.db, () => service.cycles.claimWake(task.id));
      return { reason: "already_answering" };
    }
    const name = new BotsRepo(service.deps.db).get(task.assigneeBotId)?.name ?? task.assigneeBotId;
    // Older completions have no display message; never claim a historical result was posted.
    const workspace = service.memberWorktrees.workspace(task.id);
    const integrationNote =
      workspace?.state === "awaiting_integration" ||
      workspace?.state === "conflict" ||
      workspace?.state === "interrupted"
        ? "并行任务成果保留在独立工作区，尚未合入；统筹审阅后可用 finish_task(taskId,integrate=true) 发起合入审批，不能提前宣称代码已集成。 / Parallel task outputs remain isolated. The coordinator should review and use finish_task(taskId,integrate=true) to request integration under approval policy; do not claim integration prematurely."
        : "";
    const notice = new MessagesRepo(service.deps.db).hasTaskResult(task.id)
      ? `${name} 的任务结果已经以该成员自己的名义显示在群里 / The member's result is already posted in the group under their own name.`
      : `${name} 的旧任务已完成，结果可在任务线程查看 / The member's legacy task is complete; view its result in the task thread.`;
    const parent = task.source?.parentTaskId
      ? service.tasks.get(task.source.parentTaskId)
      : undefined;
    const input: QueueInput = {
      ...(parent?.status === "open" &&
      parent.groupId === group.id &&
      parent.assigneeBotId === group.coordinatorBotId
        ? { taskId: parent.id }
        : {}),
      bot,
      conversationId: group.conversationId,
      groupId: group.id,
      userMessageId: origin.sourceMessageId,
      cycleId: origin.cycleId,
      automatic: true,
      kind: "wake",
      parentRunId: origin.finishedRunId,
      triggerKey: key,
      // The coordinator's sign-off run continues its workflow (body, folder, delivery check).
      ...(gate.kind === "wake" && gate.workflow ? { workflow: gate.workflow } : {}),
      text: service.deps.redactor.redact(
        `${notice}\n${integrationNote}\nTask / 任务: ${task.title}\nStatus / 状态: ${task.summary ?? ""}\n${gate.kind === "wake" ? `${gate.text}\n` : ""}不要逐字转述成员已发的内容；只在需要时汇总、追问或安排下一步 / Do not repeat the member's posted content verbatim; summarize, ask follow-up questions or arrange next steps only when needed.`,
      ),
    };
    const result = transaction(service.deps.db, () =>
      service.auto(
        group.id,
        origin.cycleId,
        () => {
          service.deps.chat.queue.capacity([bot.id]);
          const record = service.deps.chat.queue.insert(input);
          // If enqueue fails, both the round and claim roll back. No claim on paused/full/stale.
          if (!service.cycles.claimWake(task.id))
            throw new Error("Completion wake already claimed");
          // The sign-off run is found again by its id when it assigns the next stage.
          if (gate.kind === "wake") service.handoffs.repo.setState(task.id, "met", record.id);
          return record;
        },
        gate.kind === "wake" ? "handoff" : "free",
      ),
    );
    if (!result.value) return { reason: result.reason };
    service.deps.chat.queue.publish(result.value, input);
    if (gate.kind === "wake") {
      service.handoffs.settled(task.id);
      const current = service.tasks.get(task.id);
      if (current) service.taskChanged(current);
    }
    service.deps.local.approvals.audit.append({
      botId: task.assigneeBotId,
      runId: origin.finishedRunId,
      kind: "collaboration.queued",
      summary: "Group completion wake queued / 群任务完成唤醒已排队",
      detail: {
        ...collaborationAuditFields({
          action: "completion_wake",
          botName: new BotsRepo(service.deps.db).get(task.assigneeBotId)?.name,
          targetBotName: bot.name,
          taskTitle: task.title,
          redactor: service.deps.redactor,
        }),
        groupId: group.id,
        taskId: task.id,
        targetBotId: bot.id,
        childRunId: result.value.id,
      },
    });
    return { runId: result.value.id };
  }
  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }
}
