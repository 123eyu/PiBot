import type { LocalService, RunQueue } from "@pibot/brain/orchestration-kit";
import { ACTIVE_TASK_STATUSES, noteContinuationStopped } from "@pibot/brain/orchestration-kit";
import {
  type ContinuationResumeResult,
  RpcError,
  RpcErrorCodes,
  type TaskSummary,
} from "@pibot/protocol-base";
import type { ContinuationIntent } from "@pibot/storage";
import type { TaskContinuations } from "./task-continuations.ts";
import type { RestoreRefusal } from "./task-parent-followthrough.ts";

const SCAN_PAGE = 100;
const SUMMARY_PAGE = 200;
type Outcome = "resumed" | "discarded" | "dropped" | "kept";
type RootResult = { outcome: Exclude<Outcome, "discarded"> | "busy"; reasonCode: string };

/**
 * What happens to automatic continuations an earlier process left behind. Startup only
 * tidies and counts them per topic; nothing runs until the user confirms in that topic, and the
 * confirmation re-checks every original admission rule instead of trusting the stored row.
 */
export class ContinuationRestore {
  /** Unconfirmed roots per topic. Bounded by the 128-root ledger capacity of the last process. */
  private readonly topics = new Map<string, Set<string>>();
  private scanned = false;
  constructor(
    private readonly local: LocalService,
    private readonly continuations: TaskContinuations,
  ) {}

  /**
   * Runs once, after the queue exists and startup recovery has aborted every unfinished run and
   * interrupted every unfinished task. Rows that can never continue are released here, so the
   * prompt only offers chains a confirmation could actually resume.
   */
  scan(queue: RunQueue) {
    if (this.scanned) return;
    this.scanned = true;
    const intents = this.local.continuationState.intents;
    for (let after: string | null = null; ; ) {
      const roots = intents.roots(after, SCAN_PAGE);
      for (const root of roots) {
        const topic = this.tidy(queue, root);
        if (!topic) continue;
        const roots = this.topics.get(topic) ?? new Set<string>();
        roots.add(root);
        this.topics.set(topic, roots);
      }
      if (roots.length < SCAN_PAGE) break;
      after = roots.at(-1) ?? null;
    }
    // A crash (not a quit) skips the settle that releases a ledger, so a chain with no intent left
    // would otherwise hold one of the bounded capacity slots for good.
    const ledgers = this.local.continuationState.ledgers;
    for (let after: string | null = null; ; ) {
      const roots = ledgers.roots(after, SCAN_PAGE);
      for (const root of roots) {
        if (intents.has(root)) continue;
        if (!queue.repo.get(root) || this.continuations.chainQuiet(root)) ledgers.release(root);
      }
      if (roots.length < SCAN_PAGE) break;
      after = roots.at(-1) ?? null;
    }
    for (const [conversationId, roots] of this.topics) this.emit(conversationId, roots.size);
  }

  list(after: string | undefined, limit = 50) {
    const ids = [...this.topics.keys()].sort().filter((id) => after === undefined || id > after);
    const page = ids.slice(0, limit);
    return {
      items: page.map((conversationId) => ({
        conversationId,
        count: this.topics.get(conversationId)?.size ?? 0,
      })),
      nextAfter: ids.length > limit ? (page.at(-1) ?? null) : null,
    };
  }

  resume(queue: RunQueue, conversationId: string, signal: AbortSignal): ContinuationResumeResult {
    const roots = this.topics.get(conversationId);
    const result = { resumed: 0, dropped: 0, kept: 0, busy: 0 };
    if (!roots?.size) return result;
    if (!queue.acceptingContinuations)
      throw new RpcError(RpcErrorCodes.busy, "continuation_unavailable");
    for (const root of [...roots]) {
      // The root run row outlives every intent, so it names the audit owner after rows are gone.
      const botId = queue.repo.get(root)?.botId;
      const used = this.local.continuationBudget.peek(root)?.used ?? 0;
      const { outcome, reasonCode } = this.resumeRoot(queue, root, signal);
      result[outcome]++;
      if (outcome === "busy") continue;
      roots.delete(root);
      if (!botId) continue;
      this.audit(root, conversationId, outcome, reasonCode, botId);
      if (outcome === "dropped")
        noteContinuationStopped(this.local, {
          conversationId,
          botId,
          root,
          reasonCode: "restart_dropped",
          used,
        });
    }
    if (!roots.size) this.topics.delete(conversationId);
    this.emit(conversationId, roots.size);
    return result;
  }

  discard(queue: RunQueue, conversationId: string): { discarded: number } {
    const roots = this.topics.get(conversationId);
    if (!roots?.size) return { discarded: 0 };
    const state = this.local.continuationState;
    for (const root of roots) {
      const botId = queue.repo.get(root)?.botId;
      state.intents.release(root);
      // The chain is this process's again: the shared idle rule may now free its ledger.
      state.owned(root);
      this.continuations.finalize(root);
      if (botId) this.audit(root, conversationId, "discarded", "user_discarded", botId);
    }
    this.topics.delete(conversationId);
    this.emit(conversationId, 0);
    return { discarded: roots.size };
  }

  /**
   * Startup cleanup of one root. Returns the topic to prompt in, or nothing when the chain either
   * ended or was dropped here. Only facts the user cannot change are acted on: an ended root, a
   * plan the user already took over, and batch references that no longer match their task.
   */
  private tidy(queue: RunQueue, root: string): string | undefined {
    const run = queue.repo.get(root);
    const intents = this.local.continuationState.intents;
    const parent = intents.get(root, "parent");
    const topic = parent?.conversationId;
    if (!run || run.status === "aborted" || run.status === "error") {
      const first = parent ?? this.summaries(root)[0];
      this.continuations.forgetChain(root);
      if (first)
        this.audit(root, first.conversationId, "dropped", "root_ended", run?.botId ?? first.botId);
      return undefined;
    }
    let keepParent = !!parent;
    if (parent?.runId && queue.repo.hasNewUserRunAfter(parent.runId)) {
      this.continuations.parents.discard(root);
      this.audit(root, parent.conversationId, "dropped", "user_took_over", run.botId);
      keepParent = false;
    }
    const summaries = this.validSummaries(queue, root);
    if (!keepParent && !summaries.length) {
      // Nothing restorable remains; the ledger goes too once the chain is quiet.
      this.local.continuationState.owned(root);
      this.continuations.finalize(root);
      return undefined;
    }
    return (keepParent ? topic : undefined) ?? summaries[0]?.conversationId;
  }

  /**
   * Summary references that can still be offered. A batch marked dispatched survives only in the
   * crash window between its run row and the queue accepting it: a finished run consumed it, and
   * a run startup aborted never did.
   */
  private validSummaries(queue: RunQueue, root: string): ContinuationIntent[] {
    const intents = this.local.continuationState.intents;
    const valid: ContinuationIntent[] = [];
    for (const row of this.summaries(root)) {
      const batch = [{ subjectId: row.subjectId, version: row.taskVersion ?? -1 }];
      if (row.dispatchedRunId) {
        if (queue.repo.get(row.dispatchedRunId)?.status === "done") {
          intents.consume(root, batch);
          continue;
        }
        intents.dispatched(root, batch, null);
      }
      const task = this.local.tasks.tasks.get(row.subjectId);
      if (!task || task.version !== row.taskVersion || ACTIVE_TASK_STATUSES.has(task.status)) {
        intents.consume(root, batch);
        continue;
      }
      valid.push(row);
    }
    return valid;
  }

  private summaries(root: string): ContinuationIntent[] {
    const rows: ContinuationIntent[] = [];
    const intents = this.local.continuationState.intents;
    for (let before: string | undefined; ; ) {
      const page = intents.pageRoot(root, { limit: SUMMARY_PAGE, ...(before ? { before } : {}) });
      rows.push(...page.filter((row) => row.kind === "summary"));
      if (page.length < SUMMARY_PAGE) return rows;
      before = page.at(-1)?.id;
    }
  }

  /**
   * One confirmed chain. The parent plan and the collected results are admitted separately: a
   * plan paused for the user stays paused, and its results may still be summarized on their own.
   */
  private resumeRoot(queue: RunQueue, root: string, signal: AbortSignal): RootResult {
    const run = queue.repo.get(root);
    const state = this.local.continuationState;
    const parentRow = state.intents.get(root, "parent");
    const rows = this.validSummaries(queue, root);
    const first = run ? this.local.tasks.tasks.list(run, { rootRunId: root, limit: 1 }) : undefined;
    const source = first?.items[0];
    if (run?.status !== "done" || !source || (!parentRow && !rows.length)) {
      this.continuations.forgetChain(root);
      return { outcome: "dropped", reasonCode: "root_ended" };
    }
    const head = parentRow ?? rows[0];
    if (head && !queue.canContinue(head.botId, head.conversationId))
      return { outcome: "busy", reasonCode: "busy" };
    let tree: TaskSummary[];
    try {
      tree = this.continuations.tree(source);
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== -32602) throw error;
      this.continuations.refuse(root);
      return { outcome: "dropped", reasonCode: "task_tree_limit" };
    }
    // From here on the chain is this process's: settles and the idle rule treat it normally.
    state.owned(root);
    const wanted = new Map(rows.map((row) => [row.subjectId, row.taskVersion]));
    const items = tree.filter(
      (task) => !ACTIVE_TASK_STATUSES.has(task.status) && wanted.get(task.id) === task.version,
    );
    const restored = parentRow
      ? this.continuations.parents.restore(parentRow, tree, signal)
      : undefined;
    const parentReason: RestoreRefusal | undefined =
      restored && !restored.ok ? restored.reason : undefined;
    const kept = !!restored && !restored.ok && restored.kept;
    let summaryAuthority: ReturnType<TaskContinuations["authority"]> | undefined;
    if (items.length)
      try {
        summaryAuthority = this.continuations.authority(items);
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== -32602) throw error;
        state.intents.deleteKind(root, "summary");
      }
    const admission = restored?.ok ? restored.admission : undefined;
    if (!admission && !summaryAuthority) {
      this.continuations.finalize(root);
      return kept
        ? { outcome: "kept", reasonCode: parentReason ?? "paused" }
        : { outcome: "dropped", reasonCode: parentReason ?? "source_changed" };
    }
    if (parentReason && !kept && head)
      // The plan is gone but its results still go out: record why the plan did not continue.
      this.audit(root, head.conversationId, "dropped", parentReason, run.botId);
    if (!admission) {
      // A summary competes for the same round budget as during the original process.
      const round = this.local.continuationBudget.preview(root, "summary", true);
      if (!round.ok) {
        this.continuations.refuse(root);
        return { outcome: "dropped", reasonCode: round.reason };
      }
    }
    let queued: ReturnType<TaskContinuations["queueBatch"]>;
    try {
      // `items` is the batch this run consumes; with an admitted parent the prompt shows the tree.
      queued = this.continuations.queueBatch(
        source,
        items,
        tree,
        admission,
        summaryAuthority,
        true,
      );
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      if (error.code === RpcErrorCodes.busy) return { outcome: "busy", reasonCode: "busy" };
      this.continuations.refuse(root);
      return { outcome: "dropped", reasonCode: "source_changed" };
    }
    if (!queued) {
      this.continuations.finalize(root);
      return { outcome: "dropped", reasonCode: "not_queued" };
    }
    // A paused plan whose results were summarized is still the user's to settle.
    return kept
      ? { outcome: "kept", reasonCode: parentReason ?? "paused" }
      : { outcome: "resumed", reasonCode: admission ? "parent_resumed" : "summary_resumed" };
  }

  private emit(conversationId: string, count: number) {
    this.local.deps.peer.emit("continuations.pending", { conversationId, count });
  }

  /** Facts only: which chain, what the decision did, and why. Never plan or result text. */
  private audit(
    root: string,
    conversationId: string,
    restore: Outcome,
    reasonCode: string,
    botId: string,
  ) {
    this.local.approvals.audit.append({
      botId,
      runId: root,
      kind: "execution.continuation.restored",
      summary: "Restart continuation decision / 重启后的自动接续处理",
      detail: {
        conversationId,
        target: root,
        actor: restore === "dropped" ? "system" : "user",
        restore,
        reasonCode,
        used: this.local.continuationBudget.peek(root)?.used ?? 0,
      },
    });
  }
}
