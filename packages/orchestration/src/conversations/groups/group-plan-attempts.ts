import { createHash } from "node:crypto";
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import { GroupToolError, type ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  GROUP_PLAN_FORMAT_LIMIT,
  GROUP_PLAN_MAX_REWRITES,
  type GroupPlanAttempts,
  type KernelMethodParams,
  UserQuestionPauseSchema,
} from "@pibot/protocol-base";
import { MessagesRepo, TaskRepo, transaction } from "@pibot/storage";
import { resolvePlanLimit } from "./group-plan-limit-choice.ts";
import type { GroupService } from "./group-service.ts";
import { stepExecution } from "./group-workflow-execution.ts";

const PLANNING_TOOLS = new Set([
  "group_plan",
  "read_file",
  "list_dir",
  "find_files",
  "search_text",
  "read_messages",
]);

/** Tools that produce a deliverable; reads, plan tools and commands stay with the coordinator. */
const DELIVERABLE_WRITES = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "office_create",
  "office_edit",
]);

/**
 * A 2026-11-11 real run: right after group_plan the coordinator wrote prd.md in the
 * planning run while the prd step (its own) was still queued, so the step ran on a file it never
 * wrote and members were skipped. Steps write their deliverables in their own runs.
 */
const PLAN_OWNS_WRITES =
  "计划已经建好，交付文件由各步骤在自己的运行里写（你负责的步骤也会单独排给你）。主话题里不要写文件；现在用一两句话说明计划已交给成员，然后结束这次回复 / A plan exists, so each step writes its deliverables in its own run (steps you own are queued to you separately). Do not write files in the main topic; say in a sentence or two that the plan is with the members, then end this reply.";

const HELD =
  "计划没能提交。请向用户说明原因并等待卡片选择；不能自行执行或分派 / The plan could not be submitted. Explain the block and wait for the user's choice; do not execute or delegate work.";

const SOLO_HELD =
  "本群已改为由你独自完成，这张卡已关闭：不要再提交计划或分派，直接做完剩余工作并回复用户，仍遵守当前权限与预算 / This group continues as your solo work and the card is closed: submit no further plan and delegate nothing; finish the remaining work and reply under the same permissions and budget.";

/** A card would only block the user, so the program states the switch itself. */
export const PLAN_LIMIT_SOLO_NOTICE =
  "计划的格式错误已达上限，本群只有两人，程序已改为由你独自完成：不再提交计划、不再分派，直接做完并回复用户，仍遵守当前权限与预算 / The plan format limit is reached and this group has at most two members, so the program switched to solo work: no further plan, no delegation; finish the work and reply under the same permissions and budget. This card is closed.";

/** The program owns the gate; neither a model-authored answer nor YOLO can release it. */
export class GroupPlanAttemptsController {
  private readonly answering = new Set<string>();
  constructor(private readonly service: GroupService) {}
  stop() {
    return Promise.resolve();
  }
  private source(context: ToolRunContext) {
    const run = this.service.runs.get(context.runId);
    const group = run?.groupId ? this.service.groups.get(run.groupId) : undefined;
    if (
      !run?.cycleId ||
      !group ||
      run.botId !== context.botId ||
      run.botId !== group.coordinatorBotId ||
      run.conversationId !== context.conversationId ||
      context.threadId ||
      context.executionTaskId
    )
      return undefined;
    return { run, group, cycleId: run.cycleId };
  }
  state(context: ToolRunContext) {
    const source = this.source(context);
    return source
      ? this.service.plans.repo.attemptState(source.group.id, source.cycleId)
      : undefined;
  }
  guard(context: ToolRunContext, tool: string) {
    const run = this.service.runs.get(context.runId);
    const root = context.budgetRootRunId
      ? this.service.runs.get(context.budgetRootRunId)
      : undefined;
    const state =
      this.state(context) ??
      (run?.groupId && run.cycleId
        ? this.service.plans.repo.attemptState(run.groupId, run.cycleId)
        : undefined) ??
      (root?.groupId && root.cycleId
        ? this.service.plans.repo.attemptState(root.groupId, root.cycleId)
        : undefined);
    const groupId = run?.groupId ?? root?.groupId;
    const coordinator = groupId ? this.service.groups.get(groupId)?.coordinatorBotId : undefined;
    if (state?.status === "ended" || state?.status === "waiting") throw new GroupToolError(HELD);
    if (DELIVERABLE_WRITES.has(tool) && this.planOwnsWrites(context))
      throw new GroupToolError(PLAN_OWNS_WRITES);
    if (state?.status === "solo") {
      // The solo note is written for the coordinator; a member only needs to stop.
      if (context.botId !== coordinator) throw new GroupToolError(HELD);
      if (["group_plan", "assign_task", "task_spawn", "ask_bot"].includes(tool))
        throw new GroupToolError(SOLO_HELD);
    }
    if (state?.planningOnly && !PLANNING_TOOLS.has(tool) && !this.planStep(context))
      throw new GroupToolError(
        "延长只允许重新规划。请提交计划交给程序执行；自行执行须用户选择让统筹自己做 / Planning only: submit a plan for the engine to execute. Solo execution requires the user's explicit solo choice.",
      );
  }
  /** Only the coordinator's main-topic run of a cycle whose plan is still pending or running. */
  private planOwnsWrites(context: ToolRunContext) {
    const source = this.source(context);
    if (!source) return false;
    const card = this.service.plans.repo.forCycle(source.run.conversationId, source.cycleId)?.card;
    if (!card || card.groupId !== source.group.id || card.startFailure) return false;
    if (card.status !== "started") return true;
    return this.service.workflows.repo.executionSummary(
      source.group.id,
      source.run.conversationId,
      source.cycleId,
    ).active;
  }
  private planStep(context: ToolRunContext) {
    let run = this.service.runs.get(context.runId);
    if (run?.botId !== context.botId || run.conversationId !== context.conversationId) return false;
    const tasks = new TaskRepo(this.service.deps.db);
    for (let depth = 0; run && depth < 32; depth++) {
      const step = run.taskId ? this.service.workflows.repo.byTask(run.taskId) : undefined;
      const record = step ? this.service.workflows.repo.get(step.workflowRunId) : undefined;
      if (
        record &&
        step &&
        record.status === "running" &&
        step.status === "running" &&
        stepExecution(this.service, record, step)?.run?.id === run.id
      )
        return true;
      // Only a persisted execution-task binding can inherit a step's authority, never a model id.
      const task = tasks.forRun(run.id);
      if (
        !task ||
        task.runId !== run.id ||
        task.botId !== run.botId ||
        task.parentRunId !== run.parentRunId
      )
        return false;
      run = this.service.runs.get(task.parentRunId);
    }
    return false;
  }
  failure(context: ToolRunContext, call: LocalToolCall, failure: LocalToolResult): LocalToolResult {
    if (call.tool !== "group_plan") return failure;
    const source = this.source(context);
    if (!source || source.group.members.length < 2) return failure;
    const { group, run, cycleId } = source;
    const state = transaction(this.service.deps.db, () => {
      const old = this.service.plans.repo.attemptState(group.id, cycleId);
      if (old && old.status !== "open") return old;
      const state: GroupPlanAttempts = old ?? {
        cycleId,
        errors: 0,
        extensions: 0,
        status: "open",
        messageId: null,
        sourceRunId: run.id,
        lastCall: null,
      };
      const callKey = createHash("sha256")
        .update(JSON.stringify([run.id, call.id]))
        .digest("hex");
      if (state.lastCall !== callKey) {
        state.errors++;
        state.lastCall = callKey;
      }
      this.service.plans.repo.saveAttemptState(group.id, state);
      return state;
    });
    const remaining = Math.max(0, GROUP_PLAN_FORMAT_LIMIT + state.extensions - state.errors);
    const outcome = !remaining && state.status === "open" ? this.limit(context) : undefined;
    return {
      ...failure,
      isError: true,
      text: JSON.stringify({
        code: !remaining
          ? outcome === "solo"
            ? "plan_format_limit_solo"
            : "plan_format_limit"
          : "plan_invalid",
        details: failure.text,
        formatCorrectionsRemaining: remaining,
        rewritesRemaining: this.remaining(context),
        countsAsRewrite: false,
        ...(outcome === "solo" ? { mode: "solo", notice: PLAN_LIMIT_SOLO_NOTICE } : {}),
        instruction: remaining
          ? "修正后重试 / Correct and retry"
          : outcome === "solo"
            ? PLAN_LIMIT_SOLO_NOTICE
            : HELD,
      }),
    };
  }
  /**
   * In a two-member group delegation is not an option, so a card only blocks the user.
   * The coordinator continues alone at the same permission and budget, and is told the card is
   * closed so it does not spend its remaining attempts on another submission.
   */
  private limit(context: ToolRunContext): "hold" | "solo" | undefined {
    const source = this.source(context);
    if (!source) return undefined;
    if (source.group.members.length <= 2) return this.solo(context) ? "solo" : undefined;
    this.hold(context);
    return "hold";
  }
  private solo(context: ToolRunContext) {
    const source = this.source(context);
    if (!source || source.group.members.length > 2) return false;
    const { group, run, cycleId } = source;
    const saved = transaction(this.service.deps.db, () => {
      const state = this.state(context) ?? {
        cycleId,
        errors: 0,
        extensions: 0,
        status: "open" as const,
        messageId: null,
        sourceRunId: run.id,
        lastCall: null,
      };
      if (state.status !== "open") return false;
      this.service.plans.repo.saveAttemptState(group.id, {
        ...state,
        sourceRunId: run.id,
        status: "solo",
      });
      this.audit(context, "group_plan_limit_solo");
      return true;
    });
    if (saved) this.service.changed(group.id, "updated");
    return saved;
  }
  remaining(context: ToolRunContext) {
    const source = this.source(context);
    if (!source) return GROUP_PLAN_MAX_REWRITES + 1;
    return Math.max(
      0,
      GROUP_PLAN_MAX_REWRITES +
        1 +
        (this.state(context)?.extensions ?? 0) -
        this.service.plans.repo.attempts(source.group.id, source.cycleId, source.run.botId),
    );
  }
  hold(context: ToolRunContext) {
    const source = this.source(context);
    if (!source || source.group.members.length < 2) return;
    const { group, run, cycleId } = source;
    transaction(this.service.deps.db, () => {
      const state = this.state(context) ?? {
        cycleId,
        errors: 0,
        extensions: 0,
        status: "open" as const,
        messageId: null,
        sourceRunId: run.id,
        lastCall: null,
      };
      if (state.status !== "open") return;
      const zh = context.language !== "en";
      const pause = UserQuestionPauseSchema.parse({
        reason: "needs_user",
        fixedOptions: true,
        summary: HELD,
        question: {
          prompt: zh
            ? "计划没能提交，请选择如何继续"
            : "The plan could not be submitted. Choose what happens next.",
          recommendedId: "end",
          options: [
            {
              id: "extend",
              label: zh ? "延长上限再试" : "Extend the limit and retry",
              description: zh
                ? "再给一次计划提交机会，沿原预算继续；再失败会重新出现这张卡"
                : "One more plan submission under the same budget; if it fails again this card returns",
            },
            {
              id: "solo",
              label: zh ? "不改计划，由统筹直接做完" : "Skip the plan; coordinator does it",
              description: zh
                ? "关闭这张卡，由统筹自行执行并直接回复；仍遵守当前权限和预算"
                : "Closes this card: the coordinator executes and replies directly, under current permissions and budget",
            },
            {
              id: "end",
              label: zh ? "结束这一轮" : "End this round",
              description: zh
                ? "关闭这张卡，本轮不再执行；你可以再发消息重新开始"
                : "Closes this card and stops this round; send a new message to start again",
            },
          ],
        },
      });
      const message = new MessagesRepo(this.service.deps.db).create({
        conversationId: group.conversationId,
        botId: run.botId,
        role: "assistant",
        status: "done",
        content: "",
        usage: { executionPause: pause, groupPlanLimit: { groupId: group.id, cycleId } },
      });
      this.service.plans.repo.saveAttemptState(group.id, {
        ...state,
        sourceRunId: run.id,
        status: "waiting",
        messageId: message.id,
      });
      this.audit(context, "group_plan_limit_reached");
      this.service.deps.local.tasks.continuations.cancel(
        this.service.deps.local.budgets.root(context),
      );
    });
    if (context.todoRun) context.todoRun.paused = { reason: "checkpoint", summary: HELD };
    // The source ends on its own: it is paused at a checkpoint and later tool calls are refused
    // while the card waits. Aborting it instead would mark the cycle's budget root aborted, and
    // the plan admitted after 「延长」 would stop at once as source_stopped.
    this.service.changed(group.id, "updated");
  }
  private audit(context: Pick<ToolRunContext, "botId" | "runId" | "groupId">, reasonCode: string) {
    this.service.deps.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "execution.todo.changed",
      summary: "Group plan limit decision / 群计划上限处置",
      detail: {
        groupId: context.groupId,
        reasonCode,
        // Only the user's card answer makes a decision a user action; both limits are program facts.
        actor:
          reasonCode.startsWith("group_plan_limit_") &&
          ["group_plan_limit_reached", "group_plan_limit_solo"].includes(reasonCode)
            ? "automatic"
            : "user",
      },
    });
  }
  answer(
    messageId: string,
    reply: KernelMethodParams["execution.question.answer"]["reply"],
    signal: AbortSignal,
  ) {
    return resolvePlanLimit(
      this.service,
      messageId,
      reply,
      signal,
      this.answering,
      (context, reason) => this.audit(context, reason),
    );
  }
}
