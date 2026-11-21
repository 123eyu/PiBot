import type { BackgroundCommand, Run } from "@pibot/protocol-base";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  BackgroundContinuationsRepo,
  BotsRepo,
  ConversationsRepo,
  GroupCyclesRepo,
  GroupsRepo,
  GroupTasksRepo,
  RunsRepo,
  transaction,
} from "@pibot/storage";
import type { ChatService } from "../../conversations/chat/chat.ts";
import type { LocalService } from "../../local-service.ts";
import {
  backgroundTrigger,
  type CompletionBatch,
  completionNotice,
  completionScope,
  completionTail,
} from "./background-completion.ts";
import { enqueueCompletion } from "./background-enqueue.ts";

type Row = Omit<BackgroundCommand, "ports" | "portsVisible">;

export { backgroundTrigger };

/** Queue admission owns execution; a completion notification is never an approval. */
export class BackgroundContinuation {
  private chat?: ChatService;
  private off?: () => void;
  private readonly eligible = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly results = new Map<string, string>();
  private readonly evicted = new Set<string>();
  private readonly windows = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly capacityRetries = new Map<string, number>();
  private readonly waiting = new Map<string, number>();
  private readonly manual = new Map<string, string>();
  private readonly suppressed = new Set<string>();
  private readonly projections = new Map<
    string,
    { run: Run; rows: Row[]; previous: Map<string, string> }
  >();

  private projected(id: string) {
    return [...this.projections.values()].some((entry) => entry.rows.some((row) => row.id === id));
  }

  constructor(private readonly local: LocalService) {}

  attach(chat: ChatService) {
    this.off?.();
    this.chat = chat;
    this.off = chat.queue.onAvailable(() => this.refresh());
  }

  register(row: Row, unattended: boolean) {
    if (!unattended && !(row.status === "stopped" && row.stopReason !== "time_limit"))
      this.eligible.add(row.id);
  }

  private source(row: Row) {
    return new RunsRepo(this.local.deps.db).get(row.runId);
  }

  private valid(row: Row, explicit = false, referenceOnly = false) {
    if (!this.chat) return;
    const { db } = this.local.deps;
    const source = this.source(row);
    const conversation = row.conversationId && new ConversationsRepo(db).get(row.conversationId);
    const bot = new BotsRepo(db).get(row.botId);
    if (
      this.suppressed.has(row.id) ||
      (row.status === "stopped" && row.stopReason !== "time_limit") ||
      !source ||
      this.local.background?.foreground?.accepting(row.botId) === false ||
      !conversation ||
      conversation.archivedAt ||
      !bot ||
      bot.archivedAt ||
      source.kind === "routine" ||
      !this.eligible.has(row.id) ||
      this.local.shutdown.signal.aborted ||
      !this.chat?.queue.acceptingContinuations
    )
      return;
    if (source.groupId) {
      const group = new GroupsRepo(db).get(source.groupId);
      const cycle = new GroupCyclesRepo(db).get(source.groupId);
      if (
        !group ||
        group.paused ||
        !group.members.some((m) => m.botId === source.botId) ||
        cycle.limited ||
        (!explicit && cycle.cycleId !== source.cycleId)
      )
        return;
      if (
        source.taskId &&
        new GroupTasksRepo(db, (text) => text).get(source.taskId)?.status !== "open"
      )
        return;
    } else if (conversation.kind !== "dm" || conversation.botId !== bot.id) return;
    const facts = new BackgroundContinuationsRepo(db);
    if (
      !referenceOnly &&
      this.manual.has(row.id) &&
      facts.latestUser(source.conversationId) !== this.manual.get(row.id)
    )
      return;
    if (
      !explicit &&
      (source.status === "aborted" ||
        this.suppressed.has(row.id) ||
        source.stopReason === "user_stopped" ||
        facts.declined(source.id) ||
        (!referenceOnly && facts.superseded(source)))
    )
      return;
    return { source, bot };
  }

  state(
    row: Row,
  ): Pick<
    BackgroundCommand,
    "continuation" | "continuationRunId" | "continuationFailed" | "continuationPending"
  > {
    const resumed = new BackgroundContinuationsRepo(this.local.deps.db).resumed(row.id);
    if (resumed)
      return {
        continuation: "resumed",
        continuationRunId: resumed.id,
        continuationFailed: !!resumed.finishedAt && resumed.status !== "done",
        continuationPending: !resumed.finishedAt,
      };
    if (this.waiting.has(row.id)) return { continuation: "waiting" };
    if (this.manual.has(row.id) && this.valid(row, true)) return { continuation: "automatic" };
    if (this.valid(row) && (row.status === "running" || this.pending.has(row.id)))
      return { continuation: "automatic" };
    return { continuation: this.valid(row, true) ? "manual" : "none" };
  }

  wait(id: string) {
    const background = this.local.background;
    if (!background)
      throw new Error("background_service_not_attached: wait requires local.background");
    this.waiting.set(id, (this.waiting.get(id) ?? 0) + 1);
    background.refreshStatus(id);
    return () => {
      const count = (this.waiting.get(id) ?? 1) - 1;
      if (count) this.waiting.set(id, count);
      else this.waiting.delete(id);
      background.refreshStatus(id);
      this.refresh();
    };
  }

  /** The calling model already received the terminal result; automatic delivery would repeat it. */
  consume(row: Row, botId: string, conversationId?: string) {
    const id = row.id;
    if (
      !this.eligible.has(id) ||
      row.status === "running" ||
      row.botId !== botId ||
      !conversationId ||
      row.conversationId !== conversationId
    )
      return;
    this.suppressed.add(id);
    this.pending.delete(id);
    this.results.delete(id);
    this.capacityRetries.delete(id);
    this.local.background.refreshStatus(id);
  }

  pendingRun(runId: string) {
    // Group reconciliation precedes queue availability, after finished jobs leave the live map.
    for (const id of this.pending) {
      const row = this.local.background.repo.get(id);
      if (
        row?.runId === runId &&
        this.valid(row, this.manual.has(id)) &&
        !new BackgroundContinuationsRepo(this.local.deps.db).resumed(id)
      )
        return true;
    }
    return false;
  }

  finished(row: Row, deferUntilSource = false) {
    // A user stopped this command, or shutdown owns it: never undo that intent.
    if (row.status === "stopped" && row.stopReason !== "time_limit") {
      this.suppressed.add(row.id);
      this.pending.delete(row.id);
      this.results.delete(row.id);
      this.capacityRetries.delete(row.id);
      this.manual.delete(row.id);
      return;
    }
    const source = this.source(row);
    if (
      this.manual.has(row.id) ||
      ((source?.finishedAt || deferUntilSource) && this.valid(row, false, true))
    ) {
      this.results.set(
        row.id,
        completionTail(
          this.local.deps.redactor.redact(
            this.local.background.toolOutput(row.botId, row.id, 20_000).output ?? "",
          ),
        ),
      );
      this.pending.add(row.id);
      const scope = completionScope(row);
      if (!this.windows.has(scope)) this.windows.set(scope, Date.now() + 2000);
      this.schedule();
    }
  }

  /** Called once at queue claim, never while another SDK turn is already running. */
  project(run: Run): { text: string; reference: string } | undefined {
    const facts = new BackgroundContinuationsRepo(this.local.deps.db);
    const previous = new Map<string, string>();
    const rows = [...this.eligible]
      .map((id) => this.local.background.repo.get(id))
      .filter(
        (row): row is NonNullable<typeof row> =>
          !!row &&
          row.botId === run.botId &&
          row.conversationId === run.conversationId &&
          row.groupId === run.groupId &&
          row.runId !== run.id &&
          row.status !== "running" &&
          !!this.source(row)?.finishedAt &&
          !this.waiting.has(row.id) &&
          !this.projected(row.id) &&
          !!this.valid(row, false, true) &&
          (!facts.resumed(row.id) || !!facts.undelivered(row.id)),
      )
      .slice(0, 32);
    if (!rows.length) return;
    for (const row of rows) {
      const resumed = facts.undelivered(row.id);
      if (resumed) previous.set(row.id, resumed.id);
    }
    const zh = this.chat?.currentLanguage() === "zh";
    const notice = completionNotice(this.local, rows, zh, this.results);
    const text = [
      zh
        ? "后台命令结果作为参考补充。优先处理用户本轮请求，不自动恢复旧目标。"
        : "Background command results are supplemental reference. Prioritize the current user request; do not automatically resume the old goal.",
      ...notice.text.split("\n").slice(1),
    ].join("\n");
    this.projections.set(run.id, { run, rows, previous });
    return { text, reference: notice.reference };
  }

  validateProjection(runId: string) {
    const entry = this.projections.get(runId);
    if (!entry) return;
    const facts = new BackgroundContinuationsRepo(this.local.deps.db);
    if (
      new RunsRepo(this.local.deps.db).get(runId)?.status !== "running" ||
      entry.rows.some(
        (row) =>
          !this.valid(row, false, true) ||
          (entry.previous.has(row.id)
            ? facts.undelivered(row.id)?.id !== entry.previous.get(row.id)
            : !!facts.resumed(row.id)),
      )
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "background_source_changed");
  }

  /** Failed/setup/aborted requests retain the snapshot for a later successful user turn. */
  confirmProjection(runId: string) {
    const entry = this.projections.get(runId);
    if (!entry) return;
    const { run, rows, previous } = entry;
    // User cancellation can arrive while the provider drains an already dispatched response.
    if (
      new RunsRepo(this.local.deps.db).get(runId)?.status !== "running" ||
      rows.some((row) => !this.valid(row, false, true))
    ) {
      this.releaseProjection(runId);
      return;
    }
    this.validateProjection(runId);
    const facts = new BackgroundContinuationsRepo(this.local.deps.db);
    transaction(this.local.deps.db, () => {
      for (const row of rows) {
        const from = previous.get(row.id);
        if (from) {
          if (!facts.rebindUndelivered(row.id, from, run.id))
            throw new RpcError(RpcErrorCodes.invalidParams, "background_source_changed");
        } else facts.bind([row.id], run.id);
      }
      this.local.approvals.audit.append({
        botId: run.botId,
        runId: run.id,
        kind: "run.resumed",
        summary: "Background results attached / 已补充后台结果",
        detail: {
          actor: "automatic",
          trigger: "background_finished",
          backgroundCommandId: rows[0]?.id,
        },
      });
    });
    for (const row of rows) {
      this.pending.delete(row.id);
      this.results.delete(row.id);
      this.manual.delete(row.id);
      this.capacityRetries.delete(row.id);
      this.local.background.refreshStatus(row.id);
    }
    this.projections.delete(runId);
  }

  releaseProjection(runId: string) {
    if (this.projections.delete(runId)) this.refresh();
  }

  request(botId: string, id: string) {
    const row = this.local.background.repo.get(id);
    if (!row || row.botId !== botId || !this.valid(row, true))
      throw new RpcError(RpcErrorCodes.invalidParams, "background_continuation_unavailable");
    if (new BackgroundContinuationsRepo(this.local.deps.db).resumed(id)) return;
    if (
      !row.conversationId ||
      this.waiting.has(id) ||
      !this.chat?.queue.canContinue(botId, row.conversationId, row.runId) ||
      this.chat.queue.topicBusy(row.conversationId, row.runId)
    )
      throw new RpcError(RpcErrorCodes.busy, "background_topic_busy");
    this.manual.set(
      id,
      new BackgroundContinuationsRepo(this.local.deps.db).latestUser(row.conversationId),
    );
    if (row.status !== "running") {
      this.pending.add(id);
      // A source can have finished its SDK turn while its adopted command still owns drain.
      // Store intent now; refresh uses normal admission and cannot dispatch ahead of that owner.
      this.windows.set(completionScope(row), Date.now());
      if (
        !this.chat.queue.canContinue(botId, row.conversationId) ||
        this.chat.queue.topicBusy(row.conversationId)
      ) {
        this.local.background.refreshStatus(id);
        return;
      }
      this.pending.delete(id);
      this.capacityRetries.delete(id);
      try {
        this.enqueue([row]);
      } finally {
        this.manual.delete(id);
      }
    }
    this.local.background.refreshStatus(id);
  }

  /** The first completion fixes the deadline; later arrivals cannot keep postponing it. */
  private schedule(includeExpired = true) {
    clearTimeout(this.timer);
    const deadlines = [...this.windows.values()].filter((at) => includeExpired || at > Date.now());
    if (!deadlines.length || this.local.shutdown.signal.aborted) return;
    this.timer = setTimeout(() => this.refresh(), Math.max(1, Math.min(...deadlines) - Date.now()));
    this.timer.unref?.();
  }

  private refresh() {
    const groups = new Map<string, Row[]>();
    for (const id of [...this.pending]) {
      const row = this.local.background.repo.get(id);
      if (
        !row ||
        !this.valid(row, this.manual.has(id), true) ||
        new BackgroundContinuationsRepo(this.local.deps.db).resumed(id)
      ) {
        this.pending.delete(id);
        this.results.delete(id);
        if (this.evicted.delete(id)) this.forget(id);
        this.capacityRetries.delete(id);
        this.manual.delete(id);
        continue;
      }
      // A wait owns the next snapshot until it consumes or releases it, even at an expired deadline.
      if (
        this.waiting.has(id) ||
        this.projected(id) ||
        !this.source(row)?.finishedAt ||
        !row.conversationId
      )
        continue;
      // New user input owns the next goal; retain its results for claim-time reference delivery.
      if (!this.valid(row, this.manual.has(id))) continue;
      const key = completionScope(row);
      const rows = groups.get(key) ?? [];
      rows.push(row);
      groups.set(key, rows);
    }
    for (const [key, candidates] of groups) {
      if ((this.windows.get(key) ?? 0) > Date.now()) continue;
      const [first, ...rest] = candidates.slice(0, 32);
      if (!first?.conversationId) continue;
      const rows: CompletionBatch = [first, ...rest];
      if (
        !this.chat?.queue.canContinue(first.botId, first.conversationId) ||
        this.chat.queue.topicBusy(first.conversationId)
      )
        continue;
      try {
        this.enqueue(rows);
      } catch (error) {
        const attempt = (this.capacityRetries.get(first.id) ?? 0) + 1;
        if (
          error instanceof RpcError &&
          error.code === RpcErrorCodes.busy &&
          ["Run queue full", "Bot queue full"].includes(error.message) &&
          attempt <= 6
        ) {
          this.capacityRetries.set(first.id, attempt);
          continue;
        }
        this.local.deps.logger.warn(
          JSON.stringify({ module: "background", event: "continue_failed", jobId: first.id }),
        );
      }
      for (const row of rows) {
        this.pending.delete(row.id);
        this.results.delete(row.id);
        if (this.evicted.delete(row.id)) this.forget(row.id);
        this.capacityRetries.delete(row.id);
        this.manual.delete(row.id);
        this.local.background.refreshStatus(row.id);
      }
      if (candidates.length > rows.length) this.windows.set(key, Date.now() + 2000);
      else this.windows.delete(key);
    }
    const pendingScopes = new Set(
      [...this.pending]
        .map((id) => this.local.background.repo.get(id))
        .filter((row) => !!row)
        .map(completionScope),
    );
    for (const key of this.windows.keys()) if (!pendingScopes.has(key)) this.windows.delete(key);
    // Already checked expired windows blocked on queue/source availability; do not poll them.
    this.schedule(false);
    for (const id of this.eligible) this.local.background.refreshStatus(id);
  }

  private enqueue(rows: CompletionBatch) {
    const row = rows[0];
    const chat = this.chat;
    if (!chat || !row.conversationId) return;
    const state = this.valid(row, this.manual.has(row.id));
    if (!state?.source.finishedAt) return;
    if (
      rows.some(
        (item) =>
          !this.valid(item, this.manual.has(item.id)) ||
          this.waiting.has(item.id) ||
          new BackgroundContinuationsRepo(this.local.deps.db).resumed(item.id),
      )
    )
      return;
    enqueueCompletion(this.local, chat, rows, state, this.results, this.manual.has(row.id));
  }

  canDispatch(run: Run) {
    const facts = new BackgroundContinuationsRepo(this.local.deps.db);
    return !facts.superseded(run) && facts.jobs(run.id).every((id) => !this.suppressed.has(id));
  }
  commandIds(run: Run) {
    const ids = new BackgroundContinuationsRepo(this.local.deps.db).jobs(run.id);
    if (!ids.length && run.triggerKey?.startsWith("background_finished:batch:")) return [];
    return ids.length ? ids : [run.triggerKey?.slice("background_finished:".length) ?? ""];
  }
  async cancel(id: string) {
    if (this.eligible.has(id)) this.suppressed.add(id);
    this.pending.delete(id);
    this.capacityRetries.delete(id);
    this.manual.delete(id);
    this.results.delete(id);
    const run = new BackgroundContinuationsRepo(this.local.deps.db).resumed(id);
    if (
      run?.automatic &&
      run.triggerKey?.startsWith("background_finished:") &&
      ["queued", "running"].includes(run.status)
    )
      await this.chat?.queue.abort(run.id, undefined, { code: "cancelled" });
  }

  forget(id: string) {
    if (this.pending.has(id)) {
      this.evicted.add(id);
      return;
    }
    this.results.delete(id);
    this.suppressed.delete(id);
    this.eligible.delete(id);
    this.pending.delete(id);
    this.capacityRetries.delete(id);
    this.manual.delete(id);
    this.waiting.delete(id);
  }

  dispose() {
    this.projections.clear();
    this.evicted.clear();
    this.results.clear();
    clearTimeout(this.timer);
    this.windows.clear();
    this.suppressed.clear();
    this.off?.();
    this.chat = undefined;
    this.eligible.clear();
    this.pending.clear();
    this.capacityRetries.clear();
    this.manual.clear();
    this.waiting.clear();
  }
}
