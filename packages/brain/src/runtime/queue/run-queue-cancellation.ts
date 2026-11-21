import {
  RpcError,
  RpcErrorCodes,
  type Run,
  type RunStopCause,
  type RuntimeHealth,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  MessagesRepo,
  RunEventsRepo,
  ToolJournalRepo,
  transaction,
} from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import {
  FORCE_RELEASE_TIMEOUT_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
} from "../continuation/continuation-limits.ts";
import type { RunQueueOperations } from "./run-queue.ts";
import { abortRun, type CancelReason, type Entry } from "./run-queue-shared.ts";
import { stopSession } from "./run-stop.ts";

/**
 * The user confirmed releasing the sessions whose drain failed. The failure state is
 * re-read here, not taken from the caller, and only a session that really ended may clear the
 * isolation the failure path put in place. A stuck `finished` therefore keeps the Bot unhealthy.
 */
export async function forceReleaseStep(
  this: RunQueueOperations,
  botId: string | undefined,
  ms = FORCE_RELEASE_TIMEOUT_MS,
): Promise<RuntimeHealth> {
  const targets = botId
    ? this.drainFailedBots.has(botId)
      ? [botId]
      : []
    : [...this.drainFailedBots];
  // Nothing failed for this scope: report it instead of clearing a healthy queue.
  if (!targets.length) return this.health();
  const ids = new Set(targets);
  // A failed drain leaves its entry behind with the run still marked running; queued siblings are
  // not part of the failure and keep their place once the lock is released.
  const stuck = [...this.entries.values()].filter(
    (entry) => ids.has(entry.record.botId) && this.repo.get(entry.record.id)?.status === "running",
  );
  for (const { run } of stuck) abortRun(run, { code: "shutdown" });
  try {
    await abortable(Promise.all(stuck.map(({ run }) => run.finished)), AbortSignal.timeout(ms));
  } catch {
    // Still hung, or the session ended by throwing: either way idle is not certified.
    throw new RpcError(RpcErrorCodes.busy, "drain_unconfirmed");
  }
  for (const id of targets) this.drainFailedBots.delete(id);
  if (this.drainFailedBots.size === 0) this.drainHealthy = true;
  const health = this.health();
  // A confirmed exit may release the last failed Bot; a partial release must not tell the UI that
  // the others recovered, so the event is emitted only for the fully healthy state.
  if (health.healthy) {
    this.deps.peer.emit("runtime.health", health);
    this.notifyAvailable();
    this.pump();
  }
  return health;
}

export function cancelQueuedStep(this: RunQueueOperations, entry: Entry): void {
  abortRun(entry.run, entry.run.stopCause ?? { code: "cancelled" });
  entry.run.routine?.clock.dispose();
  transaction(this.deps.db, () => {
    // One repository write ends the run and its still-streaming bubble.
    this.repo.finish(entry.record.id, "aborted", "aborted", "aborted");
  });
  const current = this.repo.get(entry.record.id);
  const message = new MessagesRepo(this.deps.db).get(entry.record.messageId);
  if (message && !entry.input.executionTaskId)
    this.deps.peer.emit("chat.message", {
      botId: entry.record.botId,
      conversationId: entry.record.conversationId,
      runId: entry.record.id,
      messageId: message.id,
      message,
    });
  if (current) this.deps.local?.tasks.settled(current);
  this.entries.delete(entry.record.id);
  if (!entry.input.executionTaskId)
    this.deps.peer.emit("chat.error", {
      botId: entry.record.botId,
      conversationId: entry.record.conversationId,
      ...(entry.input.groupId ? { groupId: entry.input.groupId } : {}),
      ...(entry.input.threadId ? { threadId: entry.input.threadId } : {}),
      runId: entry.record.id,
      messageId: entry.record.messageId,
      code: "aborted",
      message: "aborted",
    });
  this.status(entry.record, "idle");
  this.notifyAvailable();
  if (current) {
    const seal = () => {
      transaction(this.deps.db, () => new RunEventsRepo(this.deps.db).sealTerminal(current.id));
    };
    const settling = entry.input.routine?.settled(entry.run, current);
    if (settling)
      entry.run.finished = settling
        .catch(() => this.deps.logger.error("Routine queue cancellation failed"))
        .then(seal);
    else seal();
  }
}

/** Single-run stop: abort and wait for the session. */
export async function abortStep(
  this: RunQueueOperations,
  id: string,
  routineFailureCode?: string,
  cause: RunStopCause = { code: "user_stopped" },
): Promise<void> {
  const entry = this.entries.get(id);
  // No entry means the run already ended (or never started here): stopping is idempotent.
  if (!entry) return;
  if (this.repo.get(id)?.status === "queued") {
    entry.run.routineFailureCode = routineFailureCode;
    abortRun(entry.run, cause);
    this.cancelQueued(entry);
    this.pump();
    return;
  }
  const run = entry.run;
  /**
   * The run's SDK session has returned and its outcome is already on record; only the queue's
   * bookkeeping (or a failed drain) may be left. Checked before marking the run aborted on
   * purpose: a client cleaning up its own just-finished run arrives in the window between
   * `finishedAt` and `drained` (2026-11-06 03:28:52 done, 03:28:54 abort), and flagging it here
   * would let the wrap-up record a completed run as user_stopped. A run still in flight is
   * aborted below; a run that already reported done answers ok instead of busy, which is what
   * used to stop the whole brain from the ACP disconnect path.
   */
  const ended = () => entry.drained === true || !!this.repo.get(entry.record.id)?.finishedAt;
  if (ended()) return;
  run.routineFailureCode = routineFailureCode;
  run.aborted = true;
  abortRun(run, cause);
  try {
    await stopSession(run);
  } catch (error) {
    // It may have ended while we waited; only a session that still holds the Bot open is busy.
    // A Bot already isolated by a failed drain keeps this entry only for that isolation,
    // so there is nothing left for this stop to confirm either; answering busy failed chat.abort.
    const isolated = this.drainFailedBots.has(entry.record.botId);
    if (ended() || isolated) {
      this.deps.logger.info(
        JSON.stringify({
          module: "runs",
          event: "abort_after_end",
          runId: id,
          reason: isolated ? "drain_isolated" : "ended",
        }),
      );
      return;
    }
    throw error instanceof RpcError
      ? error
      : new RpcError(-32011, "Run still stopping; Bot remains busy");
  }
}

/**
 * Waits for `entries` to drain with a hard bound. A failed drain keeps a never-settling `finished`
 * on purpose, so the callers report what is left instead of waiting on a promise
 * that will never settle — that wait is what once kept the brain from ever exiting.
 */
async function drainWithin(
  queue: RunQueueOperations,
  entries: Entry[],
  event: string,
): Promise<{ undrained: number; failed: number; remaining: ReadonlySet<string> }> {
  const remaining = new Set(entries.map((entry) => entry.record.id));
  let failed = 0;
  const settled = Promise.allSettled(
    entries.map((entry) =>
      entry.run.finished.then(
        () => void remaining.delete(entry.record.id),
        () => {
          // A rejected run did stop; counted apart because the caller decides what it means.
          failed++;
          remaining.delete(entry.record.id);
        },
      ),
    ),
  );
  try {
    await abortable(settled, AbortSignal.timeout(SHUTDOWN_DRAIN_TIMEOUT_MS));
  } catch {
    queue.deps.logger.warn(JSON.stringify({ module: "runs", event, undrained: remaining.size }));
  }
  return { undrained: remaining.size, failed, remaining };
}

export async function abortTreeStep(
  this: RunQueueOperations,
  id: string,
  cause?: RunStopCause,
): Promise<void> {
  this.deps.local?.tasks.cancelContinuationTree(id);
  // Completed intermediary sessions leave the active map, but their descendants still belong
  // to this stop. Traverse durable parent links with a bounded shared lookup cache.
  const parents = new Map<string, string | null>();
  for (const entry of this.entries.values()) parents.set(entry.record.id, entry.record.parentRunId);
  const ids = new Set<string>([id]);
  for (const entry of this.entries.values()) {
    // Group plan members can share a root without being parent/child runs.
    if ((entry.run.budgetRootRunId ?? entry.input.budgetRootRunId) === id) ids.add(entry.record.id);
    let current: string | null = entry.record.id;
    const seen = new Set<string>();
    for (let depth = 0; current && depth < 64 && !seen.has(current); depth++) {
      if (current === id) {
        ids.add(entry.record.id);
        break;
      }
      seen.add(current);
      if (!parents.has(current)) parents.set(current, this.repo.get(current)?.parentRunId ?? null);
      current = parents.get(current) ?? null;
    }
  }
  const exhausted = this.deps.local?.budgets.repo.get(id)?.exhaustedReason;
  await this.cancel((record) => ids.has(record.id), "aborted", {
    cause: cause ?? {
      code:
        exhausted === "repeated_operation"
          ? "repeated_operation"
          : exhausted
            ? "budget_exhausted"
            : "cancelled",
    },
  });
}

export async function cancelStep(
  this: RunQueueOperations,
  filter: (record: Run) => boolean,
  reason: CancelReason,
  options: { queuedOnly?: boolean; cause?: RunStopCause } = {},
): Promise<void> {
  const entries = [...this.entries.values()].filter((e) => filter(e.record));
  const cause = options.cause ?? { code: reason === "aborted" ? "user_stopped" : reason };
  // Cancel all queued entries first; releasing an active lock must not launch a cancelled sibling.
  for (const entry of entries)
    if (this.repo.get(entry.record.id)?.status === "queued") {
      abortRun(entry.run, cause);
      this.cancelQueued(entry);
    }
  if (entries.length)
    this.deps.logger.info(
      JSON.stringify({
        module: "runs",
        event: "cancelled",
        reason,
        count: entries.length,
      }),
    );
  if (!options.queuedOnly)
    await Promise.all(
      entries
        .filter((e) => this.entries.has(e.record.id))
        .map((e) => this.abort(e.record.id, undefined, cause)),
    );
}

export async function stopStep(this: RunQueueOperations): Promise<void> {
  this.stopping = true;
  this.deps.local?.tasks.continuations.pause();
  this.shutdown.abort();
  const running = [...this.entries.values()];
  // Interactive runs that already started are interrupted, not stopped by the user (owner CDP
  // test 2026-10-23: quitting mid-run showed 「已停止」 with no 「继续」). Queued interactive runs
  // stay queued for the next start's recovery, which keeps workflow runs and ends the rest as
  // `restart`; routine runs keep their own shutdown behaviour.
  const started = running
    .filter((e) => e.record.kind !== "routine" && this.repo.get(e.record.id)?.status !== "queued")
    .map((e) => e.record.id);
  await this.cancel(
    (record) => record.kind === "routine" || this.repo.get(record.id)?.status !== "queued",
    "shutdown",
  ).catch(() => {
    this.deps.logger.warn("Shutdown waiting for actual SDK drain");
  });
  await drainWithin(this, running, "shutdown_drain_timeout");
  markShutdownInterrupted(
    this,
    started,
    running.map((entry) => entry.record.id),
  );
  this.drainedListeners.clear();
  this.availability.clear();
}

function markShutdownInterrupted(queue: RunQueueOperations, ids: string[], drainedIds: string[]) {
  try {
    const { db, redactor } = queue.deps;
    const journal = new ToolJournalRepo(db);
    transaction(db, () => {
      const audit = queue.deps.local?.approvals.audit ?? new AuditRepo(db, redactor);
      for (const run of queue.repo.markInterrupted(ids))
        audit.append({
          botId: run.botId,
          runId: run.id,
          kind: "run.interrupted",
          summary: "Run interrupted by shutdown / 运行因退出中断",
          detail: {
            actor: "system",
            conversationId: run.conversationId,
            reasonCode: "shutdown_interrupted",
            entryCount: journal.uncertainCount(run.id),
          },
        });
      const events = new RunEventsRepo(db);
      for (const id of drainedIds) events.sealTerminal(id);
    });
  } catch (error) {
    // The runs already ended `aborted`; without the mark they offer retry instead of continue.
    queue.deps.logger.warn(
      JSON.stringify({
        module: "runs",
        event: "shutdown_mark_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

const ISOLATION_GRACE_MS = 10_000;

export async function drainInteractiveStep(this: RunQueueOperations): Promise<void> {
  this.deps.local?.tasks.continuations.pause();
  const interactive = (record: Run) => record.kind !== "routine";
  const pending = [...this.entries.values()].filter((entry) => interactive(entry.record));
  // An abort receipt is not SDK/tool/audit completion. Keep admission closed until finished.
  await this.cancel(interactive, "detached", { cause: { code: "remote_disconnected" } }).catch(
    () => {
      this.deps.logger.warn("Interactive detach waiting for actual SDK drain");
    },
  );
  const { failed, remaining } = await drainWithin(this, pending, "interactive_drain_timeout");
  // A run whose own drain already failed holds its Bot isolated (no second session, the Bot is
  // refused) until a confirmed release. Counting it here as well closed admission for the whole
  // client, so the window could not load anything until restart (maintainers 2026-11-18: a Bot browser
  // call stuck on x.com). Only runs not already isolated keep the client out.
  const blocking = () =>
    pending.filter(
      (entry) => remaining.has(entry.record.id) && !this.drainFailedBots.has(entry.record.botId),
    );
  // A run's own drain verdict can land just after this budget on a loaded machine; give it a
  // short, bounded chance to either finish or be isolated before judging the whole client.
  for (let waited = 0; blocking().length && waited < ISOLATION_GRACE_MS; waited += 250)
    await new Promise((resolve) => setTimeout(resolve, 250));
  if (blocking().length || failed) throw new Error("interactive_drain_unconfirmed");
}
