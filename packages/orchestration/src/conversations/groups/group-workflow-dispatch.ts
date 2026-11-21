import type { QueueInput, WorkflowRun } from "@pibot/brain/orchestration-kit";
import {
  abortable,
  groupWorkplace,
  prepareWorkflow,
  workflowLimits,
  workflowPriced,
  workspaceFiles,
} from "@pibot/brain/orchestration-kit";
import {
  RpcError,
  RpcErrorCodes,
  SkillContractSchema,
  type WorkflowStep,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import { checkMethodFolderInputs } from "./group-method-inputs.ts";
import { stepMerged, workspaceFolder, workspaceSteps } from "./group-plan-step-workspaces.ts";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import { stepHandoff, stepInstructions } from "./group-workflow-brief.ts";
import { reviewPrompt, reviewRequirements, summaryStep } from "./group-workflow-delivery-review.ts";
import { progressOf } from "./group-workflow-progress.ts";
import type { StoredWorkflow, WorkflowEngine } from "./group-workflow-snapshot.ts";

const DISPATCH_MS = 30_000;
const STEP_CONTEXT_CHARS = 7_000;
const DEPENDENCY_REFERENCES_CHARS = 4_500;
const CAPACITY_RETRIES = 6;
const CAPACITY_RETRY_MS = 250;

/**
 * One run per step attempt. A step the group's pause stopped runs again at the same attempt (a
 * pause is not a fix round), so that rerun is keyed by the run it replaces.
 */
function stepTrigger(
  service: WorkflowEngine["service"],
  workflowRunId: string,
  stepId: string,
  state: GroupWorkflowStepRecord,
) {
  const key = `group-workflow:${workflowRunId}:${stepId}:${state.attempt}`;
  return state.executionRunId && service.runs.trigger(key) ? `${key}:${state.executionRunId}` : key;
}

const cleanSummary = (value: string) =>
  [...value].map((character) => (character.charCodeAt(0) < 32 ? " " : character)).join("");

/** Admits one ready step as a task + queued run; bounded capacity retries, explicit blocks. */
export class GroupWorkflowDispatcher {
  private readonly capacityRetries = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribeAvailable: () => void;

  constructor(private readonly engine: WorkflowEngine) {
    this.unsubscribeAvailable = engine.service.deps.chat.queue.onAvailable(() => {
      const ids = new Set(
        [...this.retryTimers.keys()].map((key) => key.slice(0, key.indexOf(":"))),
      );
      for (const id of ids) this.wakeRetries(id);
    });
  }

  async dispatch(
    record: GroupWorkflowRunRecord,
    workflow: StoredWorkflow,
    definition: WorkflowStep,
    state: GroupWorkflowStepRecord,
  ) {
    const { service } = this.engine;
    try {
      assertPlanWorkplace(service, record.id);
      await this.dispatchReady(record, workflow, definition, state);
      this.clearRetry(record.id, definition.id);
    } catch (error) {
      if (this.engine.closed || service.signal.aborted) return;
      if (error instanceof RpcError && error.code === RpcErrorCodes.busy) {
        this.retryDispatch(record, definition, state);
        return;
      }
      this.engine.block(
        record,
        definition,
        state,
        error instanceof RpcError && error.message === "no_model"
          ? "model_unavailable"
          : error instanceof RpcError && error.message.startsWith("group_plan_method_input")
            ? "precheck_failed"
            : error instanceof DOMException && error.name === "TimeoutError"
              ? "dispatch_timeout"
              : "dispatch_error",
      );
    }
  }

  private dependencies(
    record: GroupWorkflowRunRecord,
    workflow: StoredWorkflow,
    definition: WorkflowStep,
  ) {
    const { service, repo } = this.engine;
    const all = new Map(repo.steps(record.id).map((item) => [item.stepId, item]));
    const dependencies = definition.dependsOn.map((dependency) => {
      const previous = all.get(dependency);
      if (previous?.status === "skipped")
        return { id: dependency, status: "skipped", artifacts: [], summary: "" };
      const deliverables = previous?.deliverables ?? [];
      return {
        id: dependency,
        status: previous?.status ?? "missing",
        artifacts: deliverables.flatMap((item) =>
          item && typeof item === "object" && "path" in item && typeof item.path === "string"
            ? [item.path]
            : [],
        ),
        summary: cleanSummary(
          service.deps.redactor.redact(
            deliverables
              .flatMap((item) =>
                item &&
                typeof item === "object" &&
                "summary" in item &&
                typeof item.summary === "string"
                  ? [item.summary]
                  : [],
              )
              .join(" "),
          ),
        )
          .trim()
          .slice(0, 80),
      };
    });
    // Plan references are explicit: retain both the producing step and deliverable identity.
    const inputs = (definition.inputs ?? []).map((reference) => {
      const previous = workflow.contract.steps?.find((step) => step.id === reference.stepId);
      const deliverable = previous?.deliverables.find(
        (item) => item.id === reference.deliverableId,
      );
      if (!deliverable || !definition.dependsOn.includes(reference.stepId))
        throw new RpcError(-32602, "group_plan_input_invalid");
      return { ...reference, path: deliverable.path };
    });
    const afterRunId = definition.dependsOn
      .map((dependency) => all.get(dependency)?.executionRunId)
      .filter((value): value is string => !!value)
      .at(-1);
    return { dependencies, inputs, afterRunId };
  }

  private async dispatchReady(
    record: GroupWorkflowRunRecord,
    workflow: StoredWorkflow,
    definition: WorkflowStep,
    state: GroupWorkflowStepRecord,
  ) {
    const { service, repo } = this.engine;
    // Maintainers 2026-11-20: a paused group starts no step; ready steps wait for continue. Without this
    // the queue guard refused the automatic run and the step was blocked as a dispatch error.
    if (service.pausedFor(record.groupId)) return;
    const states = repo.steps(record.id);
    const ledger = progressOf(repo.get(record.id) ?? record);
    const isSummary = summaryStep(record, workflow, states) === definition.id;
    const isSupplement = ledger.review?.supplementStepId === definition.id;
    if (
      isSummary &&
      states.some(
        (item) =>
          item.stepId !== definition.id &&
          (!["passed", "skipped"].includes(item.status) || !stepMerged(service, item)),
      )
    )
      return;
    const signal = AbortSignal.any([
      service.signal,
      this.engine.shutdownSignal,
      AbortSignal.timeout(DISPATCH_MS),
    ]);
    const root = repo.get(record.id)?.budgetRootRunId;
    const budget = root ? service.deps.local.budgets.repo.get(root) : undefined;
    if (
      budget &&
      (service.deps.local.budgets.repo.reason(budget) ||
        budget.requests >= budget.limits.modelRequests)
    )
      return this.engine.block(record, definition, state, "budget_exhausted");
    const group = service.active(record.groupId, state.ownerBotId);
    const frozenGroup = workflow.workplace ? { ...group, ...workflow.workplace } : group;
    const access = workspaceFiles(
      service.deps.local,
      (await groupWorkplace(service.deps.local, state.ownerBotId, frozenGroup, signal)).boundary,
    );
    if (workflow.source.kind === "dynamic" && workflow.delivery)
      await checkMethodFolderInputs(
        workflow,
        workflow.delivery.workspaceRoot,
        signal,
        access.paths.join(workflow.folder, "inputs"),
        access,
      );
    const bot = new BotsRepo(service.deps.db).get(state.ownerBotId);
    if (!bot || bot.archivedAt)
      return this.engine.block(record, definition, state, "owner_unavailable");
    service.deps.chat.queue.capacity([bot.id]);
    await service.model(bot.id, signal);
    if (
      workflow.contract.budget?.costUsd !== undefined &&
      !(await workflowPriced(service.deps, bot, workflow, signal))
    )
      return this.engine.block(record, definition, state, "model_price_unknown");
    const { dependencies, inputs, afterRunId } = this.dependencies(record, workflow, definition);
    const requiredContext = dependencies.map(({ summary: _summary, ...dependency }) => dependency);
    if (JSON.stringify(requiredContext).length > DEPENDENCY_REFERENCES_CHARS)
      return this.engine.block(record, definition, state, "dependency_context_too_large");
    const contextText = JSON.stringify({ dependencies, inputs });
    if (contextText.length > STEP_CONTEXT_CHARS)
      return this.engine.block(record, definition, state, "dependency_context_too_large");
    let memberWorkflow: WorkflowRun | undefined;
    if (typeof definition.task !== "string") {
      const skills = service.deps.local.skills;
      const skill = skills
        ? await abortable(skills.workflowSkill(bot.id, definition.task.skillId, group.id), signal)
        : undefined;
      if (!skill) return this.engine.block(record, definition, state, "skill_unavailable");
      const memberContract = skill.document.contract
        ? SkillContractSchema.parse(JSON.parse(skill.document.contract))
        : undefined;
      if (!memberContract || memberContract.steps?.length)
        return this.engine.block(record, definition, state, "skill_unavailable");
      const allowed = new Set(memberContract.inputs.map((item) => item.name));
      const prepared = await prepareWorkflow(
        skill,
        {
          params: {},
          inputs: Object.fromEntries(
            workflow.inputs
              .filter((item) => allowed.has(item.name))
              .map((item) => [item.name, item.value]),
          ),
        },
        signal,
        access,
      );
      if (!prepared.ok) return this.engine.block(record, definition, state, "precheck_failed");
      memberWorkflow = { ...prepared.workflow, folder: workflow.folder };
    }
    const spec = stepHandoff(definition, record.id);
    if (workflow.delivery)
      spec.deliveryLocation = {
        workspaceRoot: workflow.delivery.workspaceRoot,
        location: access.location,
        workspaceRevision: access.revision,
        originals: workflow.delivery.rewrites
          .filter((item) => item.stepId === definition.id)
          .map((item) => ({ path: item.to, original: item.from })),
      };
    if (memberWorkflow)
      spec.workflow = {
        skillId: memberWorkflow.skillId,
        name: memberWorkflow.name,
        version: memberWorkflow.version,
      };
    const previousTaskId = state.executionRunId
      ? service.runs.get(state.executionRunId)?.taskId
      : undefined;
    // A redone step starts from the latest merged base; its earlier workspace is never merged.
    if (previousTaskId) {
      void this.discard(previousTaskId);
      // Maintainers 2026-11-20: the replaced task must not stay 待接续 beside the new one
      // after a continue or retry. Only an open task with nothing running is closed.
      const previous = service.tasks.get(previousTaskId);
      if (previous?.status === "open" && !service.runs.hasActiveForTask(previous.id, "")) {
        const closed = service.tasks.finish(previous.id, previous.assigneeBotId, "cancelled");
        service.cycles.claimWake(previous.id);
        service.taskChanged(closed);
      }
    }
    const ownFolder = workspaceSteps(record, workflow, states).has(definition.id)
      ? workspaceFolder(workflow, definition)
      : undefined;
    let review = isSupplement
      ? state.ownerBotId === record.coordinatorBotId && state.ownerBotId === group.coordinatorBotId
        ? ledger.review
        : undefined
      : isSummary
        ? reviewRequirements(service, workflow, record, definition.id)
        : undefined;
    const brief = (text?: string) =>
      stepInstructions(
        ownFolder ? { ...workflow, folder: ownFolder } : workflow,
        definition,
        spec,
        contextText,
        previousTaskId ? service.handoffs.repo.get(previousTaskId) : undefined,
        (value) => service.deps.redactor.redact(value),
        text,
        !!ownFolder,
      );
    const reviewText =
      review && reviewPrompt(service, review, workflow.contract.steps ?? [], states);
    let instructions = brief(reviewText);
    if (!instructions && reviewText && review) {
      // Still execute the existing summary, but never pass a partial review prompt as complete.
      if (isSupplement) return this.engine.progress.stop(record, "supplement_context_too_large");
      review = { ...review, unavailable: "input_too_large" };
      instructions = brief();
    }
    if (!instructions) return this.engine.block(record, definition, state, "step_input_too_large");
    const taskInstructions = instructions;
    const task = transaction(service.deps.db, () => {
      assertPlanWorkplace(service, record.id);
      signal.throwIfAborted();
      service.active(record.groupId, bot.id, group.conversationId);
      const active = repo.get(record.id);
      if (!active || !["running", "waiting"].includes(active.status)) return undefined;
      if (workflow.source.kind === "dynamic") {
        // A pending replan owns the graph; user dispositions clear it first.
        if (progressOf(active).requested) return undefined;
        const limit = this.engine.progress.hardLimit(active, true);
        if (limit) {
          this.engine.progress.stop(active, limit);
          return undefined;
        }
      }
      const latest = repo.steps(record.id).find((item) => item.stepId === state.stepId);
      if (latest?.status !== "ready" || service.pausedFor(record.groupId)) return undefined;
      if (review && isSummary) this.engine.progress.save(active, { ...progressOf(active), review });
      const created = service.tasks.create({
        groupId: group.id,
        assigneeBotId: bot.id,
        title: definition.title,
        instructions: taskInstructions,
        createdByBotId: group.coordinatorBotId,
        // The member's prepare decides the actual workspace (or takes turns, with the reason).
        executionMode: ownFolder ? "parallel" : "serial",
      });
      service.cycles.bind(created.id, record.cycleId, record.sourceMessageId, record.id);
      const bound = service.tasks.bindUserSource(created.id, record.sourceMessageId);
      service.handoffs.repo.create({
        taskId: created.id,
        spec,
        pipeline: null,
        baseFolder: workflow.folder,
      });
      const message = new MessagesRepo(service.deps.db).create({
        conversationId: created.threadConversationId,
        botId: group.coordinatorBotId,
        role: "assistant",
        content: taskInstructions,
        status: "done",
      });
      const input: QueueInput = {
        bot,
        conversationId: created.threadConversationId,
        groupId: group.id,
        threadId: created.threadConversationId,
        taskId: created.id,
        userMessageId: message.id,
        cycleId: record.cycleId,
        automatic: true,
        kind: "group_task",
        ancestry: [group.coordinatorBotId],
        triggerKey: stepTrigger(service, record.id, definition.id, latest),
        ...(repo.get(record.id)?.budgetRootRunId
          ? { budgetRootRunId: repo.get(record.id)?.budgetRootRunId as string }
          : {}),
        budgetWorkflow: workflow,
        enforceBudgetCost: true,
        ...(afterRunId ? { afterRunId } : {}),
        ...(memberWorkflow ? { workflow: memberWorkflow } : {}),
        text: taskInstructions,
      };
      const queued = service.deps.chat.queue.insert(input);
      const root = repo.setBudgetRoot(record.id, queued.id);
      if (!root) throw new RpcError(RpcErrorCodes.internal, "group_budget_root_missing");
      // Initialize before publishing any member: whichever queued member starts first cannot
      // replace the user-confirmed whole-plan cap with its own conversation/skill limits.
      service.deps.local.budgets.repo.ensure(
        root,
        workflowLimits(
          service.deps.local.execution.get({
            botId: record.initiatorBotId,
            conversationId: group.conversationId,
          }).limits,
          workflow,
          true,
        ),
      );
      repo.updateStep(record.id, definition.id, {
        status: "running",
        taskId: created.id,
        executionRunId: queued.id,
      });
      this.engine.audit(
        record,
        "group.workflow.step_dispatched",
        "Group workflow step dispatched / 群工作流步骤已派发",
        {
          actor: "system",
          stepId: definition.id,
          attempt: state.attempt,
          taskId: bound.id,
          childRunId: queued.id,
          targetBotId: bot.id,
        },
      );
      return { task: bound, queued, input };
    });
    if (!task) return;
    service.deps.chat.queue.publish(task.queued, task.input);
    service.taskChanged(task.task);
  }

  private async discard(taskId: string) {
    const { service } = this.engine;
    try {
      await service.memberWorktrees.discardStep(taskId, service.signal);
    } catch {
      // The periodic sweep retries; a leftover workspace never blocks the new attempt.
    }
  }

  private retryDispatch(
    record: GroupWorkflowRunRecord,
    definition: WorkflowStep,
    state: GroupWorkflowStepRecord,
  ) {
    const key = `${record.id}:${definition.id}`;
    const attempt = (this.capacityRetries.get(key) ?? 0) + 1;
    this.capacityRetries.set(key, attempt);
    if (attempt > CAPACITY_RETRIES) {
      this.clearRetry(record.id, definition.id);
      this.engine.block(record, definition, state, "queue_capacity");
      return;
    }
    if (this.retryTimers.has(key)) return;
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(key);
        this.engine.schedule(record.id);
      },
      Math.min(5_000, CAPACITY_RETRY_MS * 2 ** (attempt - 1)),
    );
    timer.unref();
    this.retryTimers.set(key, timer);
  }

  private clearRetry(workflowRunId: string, stepId: string) {
    const key = `${workflowRunId}:${stepId}`;
    const timer = this.retryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(key);
    this.capacityRetries.delete(key);
  }

  private wakeRetries(workflowRunId: string) {
    for (const [key, timer] of this.retryTimers) {
      if (!key.startsWith(`${workflowRunId}:`)) continue;
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
    this.engine.schedule(workflowRunId);
  }

  stop() {
    this.unsubscribeAvailable();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.capacityRetries.clear();
  }
}
