import type { BotSession } from "@pibot/agent";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import type { ChatRun } from "../queue/chat-run.ts";
import { awaitingReply } from "./awaiting-reply.ts";
import { promiseFollowThroughPrompt, todoFollowThroughPrompt } from "./continuation-prompts.ts";
import { promisedWithoutTools } from "./execution-observation.ts";

type Result = Awaited<ReturnType<BotSession["prompt"]>>;
/** A model stop is not task completion, but an old plan is not permission to start a new run. */
export class TodoFollowThrough {
  private progress = -1;
  private plan = "";
  private promiseFollowed = false;
  constructor(
    private readonly deps: {
      local: LocalService;
      run: ChatRun;
      context: ToolRunContext;
      toolGroups?(): { active: readonly string[]; available: readonly string[] };
      toolCalls?(): number;
      replyText?(): string;
    },
  ) {}

  next(result: Result): string | undefined {
    const { local, run, context } = this.deps;
    const state = context.todoRun;
    if (
      !state ||
      state.completedTask ||
      state.paused ||
      result.stopReason !== "stop" ||
      run.aborted ||
      run.signal.aborted ||
      !context.conversationId ||
      (local.tasks.isContinuation(run.runId) && !local.tasks.isParentResume(run.runId)) ||
      local.execution.continuationMode(context) !== "execute"
    )
      return;
    // a final turn that asks the user something is waiting for an
    // answer, not stalling — another continuation would only add "继续" segments. A false
    // positive costs one extra "继续", so the judgement may lean inclusive.
    if (
      awaitingReply(
        result.finalText ?? this.deps.replyText?.() ?? "",
        this.deps.toolCalls?.() ?? result.calledTools?.length ?? 0,
      )
    ) {
      state.paused = { reason: "awaiting_reply", summary: "" };
      local.deps.logger.info(
        JSON.stringify({
          module: "chat",
          event: "todo_follow_through_skipped",
          reason: "awaiting_reply",
          audit: true,
          botId: run.botId,
          runId: run.runId,
        }),
      );
      return;
    }
    if (!state.armed) return this.promiseNext(result);
    local.budgets.assert(context);
    const plan = local.execution.todo({
      botId: context.botId,
      conversationId: context.conversationId,
    });
    if (!plan.items.some((item) => item.status === "pending" || item.status === "in_progress"))
      return this.promiseNext(result);
    const index = plan.items.findIndex((item) => item.status === "in_progress");
    const current = index >= 0 ? index : plan.items.findIndex((item) => item.status === "pending");
    const step = {
      index: current + 1,
      title: local.deps.redactor.redact(plan.items[current]?.title ?? "").slice(0, 250),
    };
    const stop = (reason: string) => {
      state.paused = {
        reason,
        summary: "",
        ...(reason === "no_progress" || reason === "round_limit"
          ? { stall: { reason, ...step } }
          : {}),
      };
      local.noteParentContinuation(context);
      local.approvals.audit.append({
        botId: context.botId,
        runId: run.runId,
        kind: "execution.todo.paused",
        summary: "TODO follow-through paused",
        detail: { conversationId: context.conversationId, reasonCode: reason },
      });
    };
    if (local.tasks.hasPendingChildren(context)) {
      stop("waiting_tasks");
      return;
    }
    const fingerprint = JSON.stringify(plan.items.map(({ id, status }) => [id, status]));
    const progressed = !(fingerprint === this.plan && this.progress === state.progress.size);
    this.plan = fingerprint;
    this.progress = state.progress.size;
    // The root's ledger holds the round limit and the no-progress streak for every continuation.
    const round = local.continuationBudget.take(local.budgets.root(context), "todo", progressed);
    if (!round.ok) {
      stop(round.reason);
      return;
    }
    const groups = this.deps.toolGroups?.();
    return todoFollowThroughPrompt(
      step,
      groups?.available.filter((id) => !groups.active.includes(id)) ?? [],
    );
  }
  private promiseNext(result: Result): string | undefined {
    const { local, run, context } = this.deps;
    if (
      this.promiseFollowed ||
      run.routine ||
      context.routineRunId ||
      context.routineSource ||
      context.executionTaskId ||
      run.worktreeReview ||
      local.tasks.hasPendingChildren(context) ||
      local.approvals.repo.blocksTaskCompletion(run.runId) ||
      !promisedWithoutTools(
        result.finalText ?? this.deps.replyText?.() ?? "",
        this.deps.toolCalls?.() ?? result.calledTools?.length ?? 0,
      )
    )
      return;
    local.budgets.assert(context);
    this.promiseFollowed = true;
    // A promise is not progress: charge the same persisted TODO/root allowance without resetting it.
    const round = local.continuationBudget.take(local.budgets.root(context), "todo", false);
    return round.ok ? promiseFollowThroughPrompt() : undefined;
  }
}
