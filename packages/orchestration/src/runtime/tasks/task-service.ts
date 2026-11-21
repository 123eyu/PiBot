import { randomUUID } from "node:crypto";
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type {
  LocalService,
  QueueInput,
  RunQueue,
  ToolRunContext,
} from "@pibot/brain/orchestration-kit";
import {
  ACTIVE_TASK_STATUSES,
  BudgetExceededError,
  type BudgetService,
  TASK_CONTINUATION_PREFIX,
  TASK_TREE_MAX,
} from "@pibot/brain/orchestration-kit";
import {
  type ExecutionScope,
  type ReviewProfile,
  ReviewProfileSchema,
  RpcError,
  type Run,
  type TaskDetail,
  type TaskSpawn,
  TaskSpawnSchema,
  type TaskSummary,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  MessagesRepo,
  RunRecoveryRepo,
  SettingsRepo,
  TaskConflictError,
  TaskRepo,
  TopicsRepo,
  transaction,
} from "@pibot/storage";
import { TaskAuthorityService } from "./task-authority.ts";
import { TaskContinuations } from "./task-continuations.ts";
import { TaskInputDelivery } from "./task-input-delivery.ts";
import { executeTaskTool } from "./task-tools.ts";

const terminal = new Set(["done", "error", "aborted", "interrupted"]);
export class TaskService extends TaskAuthorityService {
  readonly tasks: TaskRepo;
  readonly continuations: TaskContinuations;
  private queue?: RunQueue;
  private readonly stopping = new Map<string, Promise<void>>();
  onSettled?: (taskId: string, run: Run) => void;
  onReviewTaskCreated?: (profile: ReviewProfile, task: TaskSummary) => void;
  private readonly inputs: TaskInputDelivery;
  constructor(
    private readonly owner: LocalService,
    readonly budgets: BudgetService,
  ) {
    const repo = new TaskRepo(owner.deps.db);
    super(owner, repo);
    this.tasks = repo;
    this.continuations = new TaskContinuations(owner, this);
    this.inputs = new TaskInputDelivery(owner, repo, () => this.queuePort());
    repo.recover();
    budgets.validate = (context) => this.guardSync(context);
  }
  attachQueue(queue: RunQueue) {
    this.queue = queue;
    this.continuations.attach(queue);
    this.budgets.abortTree = (id) => queue.abortTree(id);
  }
  private queuePort() {
    if (!this.queue) throw new RpcError(-32602, "task_queue_unavailable");
    return this.queue;
  }
  private scope(scope: ExecutionScope) {
    if (this.tasks.isInternalConversation(scope.conversationId))
      throw new RpcError(-32602, "task_scope_unavailable");
    this.owner.execution.get(scope);
    return scope;
  }
  private scoped(scope: ExecutionScope, id: string, context?: ToolRunContext): TaskSummary {
    this.scope(scope);
    const task = this.tasks.get(id);
    if (
      !task ||
      task.deletedAt ||
      task.botId !== scope.botId ||
      task.conversationId !== scope.conversationId ||
      (context?.executionTaskId && task.rootRunId !== this.budgets.root(context))
    )
      throw new RpcError(-32602, "task_unavailable");
    if (context?.executionTaskId) {
      let ancestor = task;
      for (let depth = 0; depth < 5 && ancestor.id !== context.executionTaskId; depth++) {
        if (!ancestor.parentTaskId) throw new RpcError(-32602, "task_unavailable");
        const parent = this.tasks.get(ancestor.parentTaskId);
        if (!parent) throw new RpcError(-32602, "task_unavailable");
        ancestor = parent;
      }
      if (ancestor.id !== context.executionTaskId) throw new RpcError(-32602, "task_unavailable");
    }
    return task;
  }
  private emit(task: TaskSummary) {
    this.owner.deps.peer.emit("execution.task.changed", task);
    this.owner.approvals.audit.append({
      botId: task.botId,
      ...(task.runId ? { runId: task.runId } : {}),
      kind: "execution.task.changed",
      summary: "Task execution state changed",
      detail: {
        conversationId: task.conversationId,
        target: task.id,
        reasonCode: task.status,
        actor: "automatic",
      },
    });
  }
  assertCollectionIdle(scope: ExecutionScope) {
    this.scope(scope);
    const queue = this.queuePort();
    if (
      queue.topicBusy(scope.conversationId) ||
      this.continuations.hasPending(scope.conversationId) ||
      queue.preparing?.(scope.botId, scope.conversationId) ||
      this.owner.hasConversationWork(scope.conversationId) ||
      new TopicsRepo(this.owner.deps.db).busy(scope.conversationId) ||
      this.owner.background.repo.conversationBusy(scope.conversationId) ||
      this.tasks.sourceBackgroundBusy(scope.conversationId)
    )
      throw new RpcError(-32011, "execution_collection_busy");
  }
  list(scope: ExecutionScope, page: { before?: string; limit?: number; archived?: boolean } = {}) {
    return this.tasks.list(this.scope(scope), page);
  }
  hasPendingChildren(context: ToolRunContext): boolean {
    const source = this.source(context);
    if (!source.conversationId) return false;
    const scope = { botId: source.botId, conversationId: source.conversationId };
    const items: TaskSummary[] = [];
    let before: string | undefined;
    do {
      const page = this.tasks.list(scope, {
        rootRunId: this.budgets.root(context),
        limit: 50,
        before,
      });
      items.push(...page.items);
      if (items.length > 100) throw new RpcError(-32602, "task_tree_limit");
      before = page.nextBefore ?? undefined;
    } while (before);
    const children = new Map<string | null, TaskSummary[]>();
    for (const item of items) {
      const siblings = children.get(item.parentTaskId) ?? [];
      siblings.push(item);
      children.set(item.parentTaskId, siblings);
    }
    const pending = [...(children.get(context.executionTaskId ?? null) ?? [])];
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index];
      if (!item) continue;
      if (ACTIVE_TASK_STATUSES.has(item.status)) return true;
      pending.push(...(children.get(item.id) ?? []));
      if (pending.length > TASK_TREE_MAX) throw new RpcError(-32602, "task_tree_limit");
    }
    return false;
  }
  status(context: ToolRunContext, input: { taskId?: string; before?: string; limit?: number }) {
    const source = this.source(context);
    if (!source.conversationId) throw new RpcError(-32602, "task_scope_unavailable");
    const scope = { botId: source.botId, conversationId: source.conversationId };
    return input.taskId
      ? this.detail(scope, input.taskId, context)
      : this.tasks.list(this.scope(scope), {
          before: input.before,
          limit: input.limit,
          parentTaskId: context.executionTaskId ?? null,
          ...(context.executionTaskId ? { rootRunId: this.budgets.root(context) } : {}),
        });
  }
  detail(scope: ExecutionScope, id: string, context?: ToolRunContext): TaskDetail {
    const task = this.scoped(scope, id, context),
      budget = this.budgets.snapshot(task.rootRunId);
    if (!budget) throw new RpcError(-32602, "task_budget_unavailable");
    return {
      task,
      budget,
      checkpoint: task.runId ? (this.budgets.checkpoints.get(task.runId) ?? null) : null,
    };
  }
  history(scope: ExecutionScope, id: string, page: { before?: string; limit?: number } = {}) {
    this.scoped(scope, id);
    const internal = this.tasks.internal(id);
    if (!internal) throw new RpcError(-32602, "task_unavailable");
    const limit = page.limit ?? 25;
    const rows = new MessagesRepo(this.owner.deps.db).list(internal.conversationId, {
      before: page.before,
      limit: limit + 1,
    });
    const messages = rows.length > limit ? rows.slice(1) : rows;
    return { messages, nextBefore: rows.length > limit ? (messages[0]?.id ?? null) : null };
  }
  async spawn(context: ToolRunContext, callId: string, input: TaskSpawn, signal: AbortSignal) {
    return this.spawnWithProfile(context, callId, input, signal);
  }
  spawnReadonlyReview(
    context: ToolRunContext,
    callId: string,
    brief: { title: string; prompt: string },
    profile: ReviewProfile,
    signal: AbortSignal,
  ) {
    if (!this.onReviewTaskCreated) throw new RpcError(-32602, "review_service_unavailable");
    return this.spawnWithProfile(
      context,
      callId,
      { ...brief, mode: "plan" },
      signal,
      ReviewProfileSchema.parse(profile),
    );
  }
  private async spawnWithProfile(
    context: ToolRunContext,
    callId: string,
    input: TaskSpawn,
    signal: AbortSignal,
    reviewProfile?: ReviewProfile,
  ) {
    if (this.isContinuation(context.runId) && !this.isParentResume(context.runId))
      throw new RpcError(-32602, "task_continuation_spawn_unavailable");
    const change = TaskSpawnSchema.parse(input),
      queue = this.queuePort();
    const duplicate = this.duplicate(context.runId, callId, change, reviewProfile);
    if (duplicate) return duplicate;
    const bot = new BotsRepo(this.owner.deps.db).get(context.botId);
    if (!bot || bot.archivedAt || bot.category === "image")
      throw new RpcError(-32602, "task_model_unsupported");
    const parentAuthority = await this.freeze(context, signal, false);
    const authority = {
      ...parentAuthority,
      mode: change.mode === "plan" ? ("plan" as const) : parentAuthority.mode,
      ...(this.cheapChild(context, change) ? { modelTier: "cheap" as const } : {}),
    };
    if (reviewProfile) authority.reviewProfile = reviewProfile;
    signal.throwIfAborted();
    const parent = context.executionTaskId
      ? this.tasks.internal(context.executionTaskId)
      : undefined;
    const depth = (parent?.depth ?? 0) + 1;
    let publish: { record: Run; input: QueueInput } | undefined;
    const create = () =>
      transaction(this.owner.deps.db, () => {
        const again = this.duplicate(context.runId, callId, change, reviewProfile);
        if (again) return again;
        this.budgets.reserve(context, `${context.runId}:spawn:${callId}`, "child", { depth });
        const task = this.tasks.create({
          parentTaskId: context.executionTaskId ?? null,
          rootRunId: this.budgets.root(context),
          parentRunId: context.runId,
          toolCallId: callId,
          title: this.owner.deps.redactor.redact(change.title),
          prompt: this.owner.deps.redactor.redact(change.prompt),
          authority,
          depth,
        });
        const result = this.enqueue(task);
        // Bind the trusted review before publish can schedule its first model/tool request.
        if (reviewProfile) this.onReviewTaskCreated?.(reviewProfile, result.task);
        publish = result.publish;
        return result.task;
      });
    let task: TaskSummary;
    try {
      task = create();
    } catch (error) {
      // The creating transaction rolls back its child rows; the root's stop reason must survive it.
      if (error instanceof BudgetExceededError) this.budgets.halt(context, error.reason);
      throw error;
    }
    try {
      // The intent names the child row holding the frozen authority; a restart re-verifies it.
      this.continuations.parents.remember(context, parentAuthority, task.id);
    } catch {
      // The task row is already committed: failing the spawn here would strand it unpublished.
      // Without the intent a restart offers no parent resume for this root (fail closed).
      this.owner.deps.logger.warn(`Parent continuation intent not stored task=${task.id}`);
    }
    if (publish) queue.publish(publish.record, publish.input);
    this.emit(task);
    return task;
  }
  /**
   * A `cheap` child only for a workflow run's own spawns (not a child's grandchildren) with
   * an auxiliary model configured. Everything else about the child (policy, permissions, budget
   * root) is unchanged; whether the model was priced is decided again when the child starts.
   */
  cheapChild(context: ToolRunContext, input: TaskSpawn): boolean {
    return (
      input.model === "cheap" &&
      !!context.workflowSkillId &&
      !context.executionTaskId &&
      !!new SettingsRepo(this.owner.deps.db).get().auxiliaryModel
    );
  }
  private duplicate(
    parentRunId: string,
    callId: string,
    input: TaskSpawn,
    profile?: ReviewProfile,
  ) {
    const duplicate = this.tasks.duplicate(parentRunId, callId);
    if (!duplicate) return undefined;
    const previous = this.tasks.internal(duplicate.id);
    if (
      previous?.prompt !== this.owner.deps.redactor.redact(input.prompt) ||
      duplicate.title !== this.owner.deps.redactor.redact(input.title) ||
      JSON.stringify(previous?.authority.reviewProfile) !== JSON.stringify(profile) ||
      (input.mode === "plan" && previous?.authority.mode !== "plan")
    )
      throw new RpcError(-32602, "task_spawn_identity_changed");
    return duplicate;
  }
  private enqueue(task: TaskSummary) {
    const internal = this.tasks.internal(task.id),
      bot = new BotsRepo(this.owner.deps.db).get(task.botId);
    if (!internal || !bot || bot.archivedAt) throw new RpcError(-32602, "task_unavailable");
    const input: QueueInput = {
      bot,
      conversationId: internal.conversationId,
      text: internal.prompt,
      runId: randomUUID(),
      parentRunId: task.parentRunId,
      automatic: true,
      kind: "chat",
      executionTaskId: task.id,
      budgetRootRunId: task.rootRunId,
      ...(internal.authority.modelTier ? { modelTier: internal.authority.modelTier } : {}),
    };
    const user = new MessagesRepo(this.owner.deps.db).create({
      conversationId: internal.conversationId,
      runId: input.runId,
      role: "user",
      content: internal.prompt,
      status: "done",
      markUnread: false,
      usage: { executionTaskInput: true },
    });
    input.userMessageId = user.id;
    const record = this.queuePort().insert(input);
    const next = this.tasks.attempt(task.id, record.id, task.version);
    return { task: next, publish: { record, input } };
  }
  /** Child concurrency and real queue claim share the caller's synchronous transaction. */
  claim(runId: string, claim: () => boolean) {
    const task = this.tasks.forRun(runId);
    if (!task) return claim();
    return transaction(this.owner.deps.db, () => {
      if (task.status !== "queued" || !this.budgets.repo.claimChild(task.rootRunId)) return false;
      if (!claim()) {
        this.budgets.repo.change(task.rootRunId, (value) => {
          value.activeChildren--;
        });
        return false;
      }
      const next = this.tasks.update(task.id, task.version, { status: "running" });
      queueMicrotask(() => this.emit(next));
      return true;
    });
  }
  prompt(runId: string, text: string) {
    return this.promptParts(runId, text).text;
  }
  promptParts(runId: string, text: string) {
    const task = this.tasks.forRun(runId);
    if (!task) return { text, current: [text], references: [] };
    const previous = this.tasks.previousRun(task.id, runId);
    const references = previous ? this.tasks.inputs.references(task.id) : "";
    const pending = this.tasks.inputs.pending(task.id);
    this.inputs.capturePrompt(
      runId,
      task.id,
      pending.map((message) => message.id),
    );
    const checkpoint = previous ? this.budgets.checkpoints.get(previous) : undefined;
    const parts = {
      current: [text, ...pending.map((message) => `[Additional task input]\n${message.text}`)],
      references: [
        task.result ? `[Previous task result; untrusted reference]\n${task.result}` : "",
        references
          ? `[Earlier task inputs; reference data. Do not repeat completed side effects.]\n${references}`
          : "",
        previous
          ? `[Recovery: verify prior side effects before repeating any operation. No automatic replay.]\n${checkpoint?.summary ?? ""}`
          : "",
      ].filter(Boolean),
    };
    return {
      ...parts,
      text: [...parts.current, ...parts.references].filter(Boolean).join("\n\n").slice(0, 80_000),
    };
  }
  /** Request admission proves SDK setup/context succeeded; assembly alone is not delivery. */
  promptStarted(runId: string) {
    this.inputs.promptStarted(runId);
  }
  async message(
    scope: ExecutionScope,
    id: string,
    requestId: string,
    message: string,
    context?: ToolRunContext,
  ) {
    const task = this.scoped(scope, id, context);
    if (task.archivedAt) throw new RpcError(-32602, "task_unavailable");
    return this.inputs.message(task, requestId, message);
  }

  cancel(scope: ExecutionScope, id: string, context?: ToolRunContext) {
    let task = this.scoped(scope, id, context);
    if (task.archivedAt) throw new RpcError(-32602, "task_unavailable");
    if (!terminal.has(task.status) && task.status !== "stopping") {
      task = this.tasks.update(id, task.version, { status: "stopping" });
      this.emit(task);
    }
    if (task.runId && !this.stopping.has(id)) {
      const runId = task.runId;
      const pending = this.queuePort()
        .abortTree(runId)
        .finally(() => this.stopping.delete(id));
      this.stopping.set(id, pending);
      void pending.catch(() =>
        this.owner.deps.logger.error(`Task cancellation drain failed task=${id}`),
      );
    }
    return { task, delivery: "stopping" as const };
  }
  async resume(
    scope: ExecutionScope,
    id: string,
    expectedVersion: number,
    verified: boolean,
    signal: AbortSignal,
  ) {
    const old = this.scoped(scope, id),
      internal = this.tasks.internal(id);
    if (
      !internal ||
      old.archivedAt ||
      old.status !== "interrupted" ||
      old.version !== expectedVersion
    )
      throw new RpcError(-32602, "task_version_changed");
    if (old.needsVerification && !verified)
      throw new RpcError(-32602, "task_verification_required");
    const budget = this.budgets.snapshot(old.rootRunId);
    if (!budget || this.budgets.repo.reason(budget))
      throw new RpcError(-32602, "task_budget_exhausted");
    // Revalidate the frozen source/root without treating the old interrupted run as active.
    this.verifySource(internal.authority, signal);
    const result = transaction(this.owner.deps.db, () => {
      const current = this.tasks.get(id);
      if (!current || current.version !== expectedVersion) throw new TaskConflictError();
      return this.enqueue(current);
    });
    this.queuePort().publish(result.publish.record, result.publish.input);
    this.emit(result.task);
    return result.task;
  }
  settled(record: Run) {
    this.inputs.release(record.id);
    if (this.isParentResume(record.id))
      this.continuations.parents.settled(this.budgetRoot(record), record.id, record.status);
    this.releaseContinuation(record.id);
    const task = this.tasks.forRun(record.id);
    if (!task || terminal.has(task.status)) {
      // Root runs (and continuations, which are not tasks) settle here: the chain may be over.
      this.continuations.releaseIfIdle(this.budgetRoot(record));
      return;
    }
    const checkpoint = this.budgets.checkpoints.get(record.id);
    const wasRunning = record.startedAt !== null;
    const next = transaction(this.owner.deps.db, () => {
      if (wasRunning)
        this.budgets.repo.change(task.rootRunId, (value) => {
          value.activeChildren = Math.max(0, value.activeChildren - 1);
        });
      const message = new MessagesRepo(this.owner.deps.db).get(record.messageId);
      return this.tasks.update(task.id, task.version, {
        status: record.status === "done" ? "done" : record.status === "error" ? "error" : "aborted",
        result: this.owner.deps.redactor.redact(message?.content ?? ""),
        needsVerification:
          !!checkpoint?.sideEffectsPossible &&
          (checkpoint.phase !== "settled" || checkpoint.outcome !== "done"),
      });
    });
    this.emit(next);
    try {
      this.onSettled?.(next.id, record);
    } finally {
      this.continuations.observe(next);
    }
    this.continuations.releaseIfIdle(next.rootRunId);
  }
  budgetRoot(record: Run) {
    return (
      this.tasks.forRun(record.id)?.rootRunId ??
      (record.triggerKey?.startsWith(TASK_CONTINUATION_PREFIX) ? record.parentRunId : null) ??
      // A resumed run keeps the interrupted run's root (budget ledger and journal).
      new RunRecoveryRepo(this.owner.deps.db).root(record.id) ??
      record.id
    );
  }
  cancelContinuationTree(runId: string) {
    // A child Stop is local to its subtree. A parent Stop also cancels future summary admission.
    if (this.tasks.forRun(runId)) return;
    const record = this.queue?.repo.get(runId);
    if (!record) return;
    this.continuations.cancel(this.budgetRoot(record));
  }
  async execute(
    context: ToolRunContext,
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<LocalToolResult> {
    return executeTaskTool(this, context, call, signal);
  }
}
