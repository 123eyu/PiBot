import { setTimeout as delay } from "node:timers/promises";
import {
  type AcpGroupRunReceipt,
  type AcpGroupSnapshot,
  type KernelMethodParams,
  RpcError,
} from "@pibot/protocol-base";
import { type GroupAcpRepo, transaction } from "@pibot/storage";
import { GroupAcpTopics } from "./group-acp-topics.ts";
import type { GroupService } from "./group-service.ts";
import { deliveryReviewComplete } from "./group-workflow-delivery-review.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

/** One ACP source run owns the topic/cycle/root tuple; caller-supplied run arrays grant nothing. */
export class GroupAcpRuntime {
  readonly topics: GroupAcpTopics;
  readonly repo: GroupAcpRepo;
  constructor(private readonly service: GroupService) {
    this.topics = new GroupAcpTopics(service);
    this.repo = this.topics.repo;
  }
  metadata(groupId: string) {
    const group = this.topics.group(groupId);
    return {
      id: group.id,
      name: group.name,
      coordinatorBotId: group.coordinatorBotId,
      memberBotIds: group.members.map((m) => m.botId),
      archivedAt: group.archivedAt,
    };
  }
  list() {
    return this.service.groups.list({ limit: 200 }).flatMap((group) => {
      try {
        return [this.metadata(group.id)];
      } catch (error) {
        if (error instanceof RpcError) return [];
        throw error;
      }
    });
  }
  private source(input: AcpGroupRunReceipt) {
    this.topics.topic(input.groupId, input.topicId);
    const source = this.service.runs.get(input.runId);
    if (
      !source ||
      source.groupId !== input.groupId ||
      source.conversationId !== input.topicId ||
      source.cycleId !== input.cycleId ||
      source.messageId !== input.assistantMessageId ||
      this.service.deps.local.tasks.budgetRoot(source) !== input.budgetRootRunId
    )
      throw new RpcError(-32602, "group_acp_source_changed");
    return source;
  }
  snapshot(input: AcpGroupRunReceipt): AcpGroupSnapshot {
    const source = this.source(input),
      group = this.topics.group(input.groupId);
    const executions = this.repo.executionTasks(input.budgetRootRunId);
    const ids = [
      ...new Set([
        ...this.repo.runIds(input.groupId, input.topicId, input.cycleId),
        ...executions.flatMap((task) => (task.runId ? [task.runId] : [])),
      ]),
    ];
    const tasks = this.repo.tasks(input.groupId, input.topicId, input.cycleId);
    const workflowIds = this.repo.workflowIds(input.groupId, input.topicId, input.cycleId);
    if (ids.length > 512 || tasks.length + executions.length > 512 || workflowIds.length > 128)
      throw new RpcError(-32011, "group_acp_capacity");
    const runs = ids.map((id) => this.service.runs.get(id)).filter((r) => r !== undefined);
    const own = new Set(ids);
    const activeRunIds = runs
      .filter((r) => ["queued", "running", "waiting"].includes(r.status))
      .map((r) => r.id);
    const workflows = workflowIds
      .map((id) => this.service.workflows.repo.get(id))
      .filter((w) => w !== undefined);
    // Replans keep their root: an obsolete cancelled version cannot override its replacement.
    const latest = new Map<string, (typeof workflows)[number]>();
    for (const workflow of workflows) latest.set(workflow.budgetRootRunId ?? workflow.id, workflow);
    const current = [...latest.values()];
    const pending = this.service.plans.repo.forCycle(input.topicId, input.cycleId)?.card;
    const approval = ids.some((id) => this.repo.approvalPending(id));
    const busyWorkflow = current.some((w) => w.status === "running" || w.status === "waiting");
    const queued = this.service.deps.chat.queue.resources().contexts.some((r) => own.has(r.runId));
    const background = ids.some((id) => this.repo.backgroundActive(id));
    const openTasks = tasks.some((task) => task.status === "open");
    const busyExecution = executions.some((task) =>
      ["queued", "running", "stopping"].includes(task.status),
    );
    const drained =
      !activeRunIds.length &&
      !queued &&
      !background &&
      !busyWorkflow &&
      !openTasks &&
      !busyExecution &&
      !approval;
    const conclusions = current.map((workflow) => {
      const published = this.repo.planConclusion(input.topicId, workflow.id, input.cycleId);
      if (published) return published;
      // Old save-template evidence is usable only with its durable coverage facts. Unknown
      // historical coverage is not upgraded into a delivery claim.
      if (!this.repo.planPublished(input.topicId, workflow.id)) return undefined;
      const stored = workflowOf(workflow);
      const review = progressOf(workflow).review;
      if (stored.source.kind !== "dynamic") return "completed";
      if (!review?.coverage) return undefined;
      return deliveryReviewComplete(review) ? "completed" : "incomplete";
    });
    const planComplete =
      current.length > 0 &&
      current.every((w, index) => w.status === "passed" && conclusions[index] === "completed");
    const planIncomplete = current.some(
      (w, index) => w.status === "passed" && conclusions[index] === "incomplete",
    );
    const soloComplete =
      !current.length &&
      !openTasks &&
      runs.some((r) => r.botId === group.coordinatorBotId && this.repo.completion(r.id));
    const stopped = this.repo.stopped(input.runId);
    const cycle = this.service.cycles.get(input.groupId);
    const stale = cycle.cycleId !== input.cycleId || source.botId !== group.coordinatorBotId;
    const limited =
      cycle.limited ||
      !!this.service.deps.local.budgets.repo.get(input.budgetRootRunId)?.exhaustedReason;
    const complete =
      !group.paused &&
      !limited &&
      !stopped &&
      !stale &&
      drained &&
      !approval &&
      !(pending && ["pending", "ready", "starting", "modify"].includes(pending.status)) &&
      (planComplete || soloComplete);
    let state: AcpGroupSnapshot["state"] = "waiting_input";
    if (stopped || stale) state = "cancelled";
    else if (planIncomplete && drained) state = "failed";
    else if (group.paused) state = "paused";
    else if (limited) state = "limited";
    else if (complete) state = "completed";
    else if (pending && ["pending", "ready", "starting", "modify"].includes(pending.status))
      state = "waiting_plan";
    else if (
      approval ||
      runs.some((r) => r.status === "waiting") ||
      current.some((w) => w.status === "waiting")
    )
      state = "waiting_input";
    else if (activeRunIds.length || queued || busyWorkflow || busyExecution) state = "running";
    else if (source.status === "error" || current.some((w) => w.status === "failed"))
      state = "failed";
    else if (source.status === "aborted") state = "cancelled";
    return {
      ...input,
      runIds: ids,
      state,
      activeRunIds,
      conversationIds: [...new Set(runs.map((r) => r.conversationId))],
      taskIds: [...tasks.map((t) => t.id), ...executions.map((t) => t.id)],
      workflowRunIds: workflowIds,
      complete,
      terminal: drained && ["completed", "failed", "cancelled"].includes(state),
      drained,
      ...(state === "failed"
        ? { failureCode: "group_acp_failed" as const }
        : state === "cancelled"
          ? { failureCode: stale ? ("group_acp_stale" as const) : ("group_acp_cancelled" as const) }
          : {}),
      runs: runs.map((r) => ({
        runId: r.id,
        botId: r.botId,
        conversationId: r.conversationId,
        status: r.status,
      })),
    };
  }
  async send(params: KernelMethodParams["groups.acp.send"], signal: AbortSignal) {
    await this.topics.verifyRoots(params.groupId, params.topicId, signal);
    const group = this.topics.group(params.groupId);
    if (group.conversationId !== params.topicId) throw new RpcError(-32602, "group_topic_stale");
    const cycle = this.service.cycles.get(group.id).cycleId;
    if (cycle) {
      const existing = this.repo.runIds(group.id, params.topicId, cycle);
      const tasks = this.repo.tasks(group.id, params.topicId, cycle);
      const card = this.service.plans.repo.forCycle(params.topicId, cycle)?.card;
      const own = new Set(existing);
      const roots = new Set(
        existing.flatMap((id) => {
          const run = this.service.runs.get(id);
          return run ? [this.service.deps.local.tasks.budgetRoot(run)] : [];
        }),
      );
      const executions = [...roots].flatMap((root) => this.repo.executionTasks(root));
      const liveWorkflow = this.repo.workflowIds(group.id, params.topicId, cycle).some((id) => {
        const record = this.service.workflows.repo.get(id);
        return record && ["running", "waiting"].includes(record.status);
      });
      if (
        this.service.deps.chat.queue.resources().contexts.some((context) => own.has(context.runId))
      )
        throw new RpcError(-32011, "group_cleanup_unconfirmed");
      if (
        this.service.runs.hasActiveForCycle(group.id, cycle) ||
        tasks.some((t) => t.status === "open") ||
        executions.some((t) => ["queued", "running", "stopping"].includes(t.status)) ||
        existing.some((id) => this.repo.backgroundActive(id) || this.repo.approvalPending(id)) ||
        liveWorkflow ||
        (card && ["pending", "ready", "starting", "modify"].includes(card.status))
      )
        throw new RpcError(-32011, "group_acp_cycle_busy");
      if (existing.length > 512) throw new RpcError(-32011, "group_acp_capacity");
    }
    signal.throwIfAborted();
    // Once dispatched, receive the owned run even if the caller cancels; ACP aborts this exact tuple.
    const receipt = await this.service.sendAcp(params);
    const source = this.service.runs.get(receipt.runId);
    if (!source?.cycleId) throw new RpcError(-32603, "group_acp_receipt_missing");
    return {
      runId: source.id,
      assistantMessageId: source.messageId,
      groupId: group.id,
      topicId: params.topicId,
      cycleId: source.cycleId,
      budgetRootRunId: this.service.deps.local.tasks.budgetRoot(source),
      runIds: receipt.runs.map((r) => r.runId),
    };
  }
  async cancel(input: AcpGroupRunReceipt) {
    const source = this.source(input);
    const before = this.snapshot(input);
    transaction(this.service.deps.db, () => {
      if (!this.repo.stopped(input.runId)) {
        this.repo.stop(input.runId);
        this.service.deps.local.approvals.audit.append({
          botId: source.botId,
          runId: source.id,
          kind: "run.interrupted",
          summary: "User stopped ACP group work",
          detail: {
            actor: "user",
            reasonCode: "user_stop_requested",
            groupId: input.groupId,
            conversationId: input.topicId,
          },
        });
      }
      for (const id of before.runIds) {
        this.service.runs.requestUserStop(id);
        this.service.deps.local.approvals.cancel(id);
        this.service.deps.local.approvals.repo.finishPending("cancelled", { runId: id });
      }
      this.service.cycles.limit(input.groupId, input.cycleId);
      for (const id of before.workflowRunIds) {
        const record = this.service.workflows.repo.get(id);
        if (record && ["running", "waiting"].includes(record.status))
          this.service.workflows.progress.stop(record, "user_stopped", "user");
      }
    });
    for (const task of this.repo.tasks(input.groupId, input.topicId, input.cycleId)) {
      const current = this.service.tasks.get(task.id);
      if (current?.status !== "open") continue;
      await this.service.cancelTaskSends(current);
      this.service.taskChanged(this.service.tasks.finish(task.id, task.botId, "cancelled"));
      this.service.cycles.claimWake(task.id);
    }
    for (const task of this.repo.executionTasks(input.budgetRootRunId))
      if (["queued", "running", "stopping"].includes(task.status))
        this.service.deps.local.tasks.cancel(
          { botId: task.botId, conversationId: task.conversationId },
          task.id,
        );
    await this.service.deps.chat.queue.abortTree(input.budgetRootRunId, { code: "user_stopped" });
    const owned = new Set(this.repo.runIds(input.groupId, input.topicId, input.cycleId));
    await this.service.deps.chat.queue.cancel(
      (r) => r.groupId === input.groupId && r.cycleId === input.cycleId && owned.has(r.id),
      "aborted",
    );
    const deadline = Date.now() + 5000;
    let latest = this.snapshot(input);
    while (!latest.drained && Date.now() < deadline) {
      await delay(100);
      latest = this.snapshot(input);
    }
    this.service.changed(input.groupId, "updated");
    return latest;
  }
}
