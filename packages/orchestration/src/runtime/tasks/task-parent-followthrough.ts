import type {
  ContinuationStop,
  Ledger,
  LocalService,
  TakeResult,
  ToolRunContext,
} from "@pibot/brain/orchestration-kit";
import {
  ACTIVE_TASK_STATUSES,
  CONTINUATION_ROOT_CAPACITY,
  continuedMode,
  noteContinuationStopped,
  runPermissions,
  taskPermissionsNarrowed,
} from "@pibot/brain/orchestration-kit";
import { RpcError, type TaskSummary } from "@pibot/protocol-base";
import { type ContinuationIntent, RunsRepo, type TaskAuthority } from "@pibot/storage";

interface ParentIntent {
  /** Absent for an intent restored from an earlier process: only its confirmed round may run. */
  context?: ToolRunContext;
  authority: TaskAuthority;
  /** Fingerprint of the plan and progress size at the last admitted continuation. */
  plan?: string;
  progress?: number;
  /** Evaluation of the continuation dispatch currently being prepared, consumed by `admitted`. */
  next?: { plan: string; progress: number; progressed: boolean };
}

/** What a parent continuation run is queued with; the authority is the frozen child snapshot. */
export interface ParentAdmission {
  authority: TaskAuthority;
  planVersion: number;
  afterRunId: string;
}
/** Reason codes only: why a restored parent intent was not continued after a restart. */
export type RestoreRefusal =
  | ContinuationStop
  | "pause_unknown"
  | "paused"
  | "source_changed"
  | "run_changed"
  | "user_took_over"
  | "children_active"
  | "children_interrupted"
  | "needs_verification"
  | "plan_changed"
  | "plan_done"
  | "mode_changed"
  | "permissions_narrowed";
export type RestoreResult =
  | { ok: true; admission: ParentAdmission }
  | { ok: false; reason: RestoreRefusal; kept: boolean };

/** Child data cannot authorize work: retain the originating parent's intent separately. */
export class TaskParentFollowThrough {
  private readonly parents = new Map<string, ParentIntent>();
  constructor(private readonly local: LocalService) {}

  /**
   * `taskId` is the child row holding the frozen authority: the restored intent re-reads it and
   * re-verifies source/permissions instead of trusting anything written here.
   */
  remember(context: ToolRunContext, authority: TaskAuthority, taskId: string) {
    if (context.executionTaskId || !context.todoRun || authority.mode !== "execute") return;
    if (!context.conversationId) return;
    const root = this.local.budgets.root(context);
    if (!this.parents.has(root) && this.parents.size >= CONTINUATION_ROOT_CAPACITY) {
      // Dropping the intent cannot strand a run (the plain summary path still applies), but a
      // silent drop would look like a follow-through that never happened.
      this.local.deps.logger.warn(`Parent follow-through capacity reached root=${root}`);
      return;
    }
    // A later spawn refreshes the intent's context but keeps the round history of the same root.
    const parent = { ...this.parents.get(root), context, authority };
    this.parents.set(root, parent);
    this.local.continuationState.owned(root);
    // Write-through on every spawn: a pause which happened after the first spawn must not be
    // replaced by a stale spawn-time state, so read the live context each time.
    this.local.continuationState.intents.save({
      rootRunId: root,
      kind: "parent",
      subjectId: "",
      botId: context.botId,
      conversationId: context.conversationId,
      runId: context.runId,
      authorityRef: taskId,
      planVersion: context.todoRun?.planVersion ?? null,
      planFingerprint: parent.plan ?? null,
      progress: parent.progress ?? null,
      triggerId: null,
      groupId: context.groupId ?? null,
      taskId,
      pauseState: context.todoRun?.paused ? "paused" : "clear",
      pauseReason: context.todoRun?.paused?.reason ?? null,
      taskVersion: null,
      dispatchedRunId: null,
    });
  }

  prepare(root: string, tree: TaskSummary[]): ParentAdmission | undefined {
    const parent = this.parents.get(root);
    // Rows from an earlier process carry a plan this process never admitted: only the user's
    // confirmation with the original admission re-check may continue them (T3), never a dispatch.
    if (!parent?.context || !this.local.continuationState.owns(root)) {
      this.parents.delete(root);
      return;
    }
    if (tree.some((task) => ACTIVE_TASK_STATUSES.has(task.status))) return;
    const { context, authority } = parent;
    const state = context.todoRun;
    const runs = new RunsRepo(this.local.deps.db);
    const scope = { botId: context.botId, conversationId: context.conversationId as string };
    const plan = this.local.execution.todo(scope);
    const fingerprint = JSON.stringify(plan.items.map(({ id, status }) => [id, status]));
    const progress = state?.progress.size ?? 0;
    const progressed = fingerprint !== parent.plan || progress !== parent.progress;
    // The same resolver as the resumed run itself: frozen snapshot first, live Plan still narrows it.
    const mode = this.local.execution.continuationMode(context);
    if (
      !state?.armed ||
      runs.get(context.runId)?.status !== "done" ||
      runs.hasNewUserRunAfter(context.runId) ||
      tree.some((task) => task.needsVerification) ||
      state.planVersion !== plan.version ||
      !plan.items.some((item) => item.status === "pending" || item.status === "in_progress") ||
      mode !== "execute"
    ) {
      // The plan the row names can no longer be continued: nothing to restore either.
      this.discard(root);
      return;
    }
    // `waiting_tasks` is this process's own certified wait: the tree is drained, so the parent may
    // continue. Every other pause belongs to the user or the host and must not be continued, and
    // its durable reason must survive this refusal.
    if (state.paused && state.paused.reason !== "waiting_tasks") {
      this.parents.delete(root);
      return;
    }
    this.local.tasks.verifySource(authority, this.local.shutdown.signal);
    if (taskPermissionsNarrowed(authority.permissions, runPermissions(this.local, context))) {
      // The frozen authority no longer holds: this chain may not run or be restored.
      noteContinuationStopped(this.local, {
        conversationId: scope.conversationId,
        botId: context.botId,
        root,
        reasonCode: "authority_narrowed",
        used: this.local.continuationBudget.peek(root)?.used ?? 0,
      });
      this.discard(root);
      return;
    }
    // Publish can still be skipped after this point (dedupe key, archived Bot), so only preview
    // here and record the round with the run row in `commit`.
    const round = this.local.continuationBudget.preview(root, "parent", progressed);
    if (!round.ok) {
      this.recordLimit(context, root, round.reason);
      this.discard(root);
      return;
    }
    // A pause after this point is durable, so a crash cannot resume a paused plan from the row.
    this.local.continuationState.intents.pause(
      root,
      state.paused ? "paused" : "clear",
      state.paused?.reason ?? null,
    );
    parent.next = { plan: fingerprint, progress, progressed };
    return { authority, planVersion: plan.version, afterRunId: context.runId };
  }

  /**
   * P3-T3: re-admits a parent intent an earlier process stored, after the user confirmed. Nothing
   * in the row authorizes work: the frozen authority is re-read from the child task row and every
   * original admission rule (`prepare`) is re-checked against the live state. A plan paused for
   * the user or the host stays paused and keeps its row; any other refusal drops the intent.
   */
  restore(row: ContinuationIntent, tree: TaskSummary[], signal: AbortSignal): RestoreResult {
    const root = row.rootRunId;
    const refuse = (reason: RestoreRefusal): RestoreResult => {
      this.discard(root);
      return { ok: false, reason, kept: false };
    };
    // Rows from before migration 0063 never recorded a pause; "not paused" would be a guess.
    if (row.pauseState === "unknown") return refuse("pause_unknown");
    if (row.pauseState === "paused" && row.pauseReason !== "waiting_tasks")
      return { ok: false, reason: "paused", kept: true };
    const authority = row.authorityRef
      ? this.local.tasks.tasks.internal(row.authorityRef)?.authority
      : undefined;
    if (authority?.mode !== "execute" || !row.runId || row.planVersion === null)
      return refuse("source_changed");
    const runs = new RunsRepo(this.local.deps.db);
    if (runs.get(row.runId)?.status !== "done") return refuse("run_changed");
    if (runs.hasNewUserRunAfter(row.runId)) return refuse("user_took_over");
    // Startup interrupted every unfinished child: their results are not the drained, verified
    // tree the plan waited for. The user resumes those subtasks explicitly (Q1).
    if (tree.some((task) => ACTIVE_TASK_STATUSES.has(task.status)))
      return refuse("children_active");
    if (tree.some((task) => task.needsVerification)) return refuse("needs_verification");
    if (tree.some((task) => task.status === "interrupted")) return refuse("children_interrupted");
    const scope = { botId: row.botId, conversationId: row.conversationId };
    const plan = this.local.execution.todo(scope);
    if (plan.version !== row.planVersion) return refuse("plan_changed");
    if (!plan.items.some((item) => item.status === "pending" || item.status === "in_progress"))
      return refuse("plan_done");
    if (continuedMode(authority.mode, this.local.execution.get(scope).mode) !== "execute")
      return refuse("mode_changed");
    try {
      this.local.tasks.verifySource(authority, signal);
      const current = runPermissions(this.local, { ...scope, groupId: row.groupId ?? undefined });
      if (taskPermissionsNarrowed(authority.permissions, current))
        return refuse("permissions_narrowed");
    } catch (error) {
      if (error instanceof RpcError && error.code === -32602) return refuse("source_changed");
      throw error;
    }
    const fingerprint = JSON.stringify(plan.items.map(({ id, status }) => [id, status]));
    const progress = row.progress ?? 0;
    // A restart is not progress: only a plan that changed since the last admitted round counts.
    const progressed = fingerprint !== row.planFingerprint;
    const round = this.local.continuationBudget.preview(root, "parent", progressed);
    if (!round.ok) return refuse(round.reason);
    this.parents.set(root, {
      authority,
      ...(row.planFingerprint === null ? {} : { plan: row.planFingerprint }),
      ...(row.progress === null ? {} : { progress: row.progress }),
      next: { plan: fingerprint, progress, progressed },
    });
    this.local.continuationState.owned(root);
    return { ok: true, admission: { authority, planVersion: plan.version, afterRunId: row.runId } };
  }

  /** Facts only: this parent was not resumed, why, and how many rounds the root had spent. */
  private recordLimit(context: ToolRunContext, root: string, reasonCode: ContinuationStop) {
    if (context.conversationId)
      noteContinuationStopped(this.local, {
        conversationId: context.conversationId,
        botId: context.botId,
        root,
        reasonCode,
        used: this.local.continuationBudget.peek(root)?.used ?? 0,
      });
    this.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "execution.continuation.limited",
      summary: "Automatic continuation stopped at its limit / 自动接续已达到上限",
      detail: {
        conversationId: context.conversationId,
        target: root,
        actor: "automatic",
        reasonCode,
        used: this.local.continuationBudget.peek(root)?.used ?? 0,
      },
    });
  }
  /** The counters before a dispatch, so a rejected publish restores the exact previous round. */
  baseline(root: string): { plan?: string; progress?: number } {
    const parent = this.parents.get(root);
    return { plan: parent?.plan, progress: parent?.progress };
  }
  /**
   * Queues the round with the run row and its audit entry: taking it here means a crash after
   * the insert cannot hand the same root an extra round on restart.
   */
  commit(root: string): TakeResult {
    const parent = this.parents.get(root);
    if (!parent?.next) return { ok: true };
    const result = this.local.continuationBudget.take(root, "parent", parent.next.progressed);
    if (!result.ok) return result;
    this.local.continuationState.intents.baseline(root, parent.next.plan, parent.next.progress);
    return result;
  }
  /** Publish was rejected: undo the persisted round and baseline written by `commit`. */
  rollback(root: string, previous: { plan?: string; progress?: number }, ledger?: Ledger) {
    this.local.continuationBudget.refund(root, ledger);
    this.local.continuationState.intents.baseline(
      root,
      previous.plan ?? null,
      previous.progress ?? null,
    );
  }
  /** Publish was accepted: only now does the in-memory baseline advance. */
  admitted(root: string) {
    const parent = this.parents.get(root);
    if (!parent?.next) return;
    const { plan, progress } = parent.next;
    delete parent.next;
    parent.plan = plan;
    parent.progress = progress;
  }
  settled(root: string, runId: string, status: string) {
    const parent = this.parents.get(root);
    // A resumed parent which spawned nothing has no future child event to wait
    // for; its same-run TODO driver already owns any remaining work.
    if (parent && (status !== "done" || parent.context?.runId !== runId)) this.forget(root);
  }
  forget(root: string) {
    const row = this.local.continuationState.intents.get(root, "parent");
    this.parents.delete(root);
    // A pause the user or the host has to settle is not this process's to erase: the row keeps the
    // reason a restart prompt shows, and only its execution eligibility is dropped here.
    if (row && row.pauseState !== "clear") return;
    this.local.continuationState.intents.delete(root, "parent");
  }
  /** The plan can never be continued or restored (changed source, spent budget, finished work). */
  discard(root: string) {
    this.parents.delete(root);
    this.local.continuationState.intents.delete(root, "parent");
  }
  /** Cache-only clear on app pause/dispose: a restart still sees the unconfirmed intent. */
  clear() {
    this.parents.clear();
  }
}
