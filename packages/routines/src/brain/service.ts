import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import type { BrainHost, BrainRedactor, LocalService, RunQueue } from "@pibot/brain/kit";
import { abortable, requireImageModel } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";
import {
  type AuditDetail,
  type AuditEntry,
  type Events,
  type Methods,
  type Peer,
  type Routine,
  type RoutineDraftInput,
  type RoutinePatch,
  type RoutineRun,
  type RoutineTiming,
  RoutineTimingDefaults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { TriggerQueue } from "@pibot/scheduler";
import { AuditRepo, BotsRepo, transaction } from "@pibot/storage";
import {
  RoutineRunsRepo,
  RoutineSettingsRepo,
  RoutinesRepo,
  RoutineTriggersRepo,
} from "../store/index.ts";
import { RoutineExecution } from "./execution/execution.ts";
import type { RoutineHostAdapter } from "./host-adapter.ts";
import { RoutineHostService } from "./host-bridge.ts";
import { RoutineAuthorization } from "./preauth/authorization.ts";
import { scheduleOnce, validateNewOnce } from "./schedule/once.ts";
import { RoutineSchedule } from "./schedule/schedule.ts";
import { RoutineAppTriggers } from "./triggers/app-triggers.ts";
import { commitAssociations, prepareAssociations } from "./triggers/associations.ts";
import { routineMutationVersion } from "./validation/mutation-version.ts";
import { appTriggerIssue, retainedPreauth, validateRoutine } from "./validation/validation.ts";
import { routineRunPages } from "./views/run-pages.ts";
import { retireRoutineWorkflows } from "./workflow-retirement.ts";

/** Resumes of one occurrence; beyond this the task needs fixing, not another attempt. */
const MAX_RESUMES = 5;

export class RoutineService {
  proposals?: import("./proposals/service.ts").RoutineProposalService;
  readonly repo: RoutinesRepo;
  readonly runs: RoutineRunsRepo;
  /** Pre-authorization of this capability's unattended runs (also the kernel's port). */
  readonly authorization: RoutineAuthorization;
  readonly settings: RoutineSettingsRepo;
  readonly triggers: RoutineTriggersRepo;
  readonly execution: RoutineExecution;
  readonly host: RoutineHostService;
  /** Connection and calendar triggers. */
  readonly appTriggers: RoutineAppTriggers;
  timing: RoutineTiming = { ...RoutineTimingDefaults };
  readonly lifetime = new AbortController();
  readonly queue = new TriggerQueue();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private lastTick = 0;
  private lastMonotonicTick = 0;
  private recovery = true;
  private graceUntil = 0;
  stopping = false;
  sleeping = false;
  activity?: () => boolean;
  private readonly mutations = new Set<string>();
  private readonly onceRecovery = new Set<string>();
  private readonly invalidAuthorization = new Map<string, number>();
  async withMutation<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.mutations.has(id)) throw new RpcError(-32011, "Routine mutation busy");
    this.mutations.add(id);
    try {
      return await action();
    } finally {
      this.mutations.delete(id);
      this.lastMonotonicTick = -Infinity;
      // A watcher resync failure must not replace the mutation's own result or error.
      if (!this.stopping && !this.lifetime.signal.aborted)
        await this.syncWatchers().catch(() => {
          this.deps.logger.warn(`Routine watcher resync failed routine=${id}`);
        });
    }
  }
  isMutating(id: string) {
    return this.mutations.has(id);
  }
  resumedOnce(before: Routine, after: Routine) {
    if (
      (!before.enabled || before.pausedReason) &&
      after.enabled &&
      !after.pausedReason &&
      after.triggers.some((t) => t.config.kind === "once")
    )
      this.onceRecovery.add(after.id);
  }
  scheduleCurrent(snapshot: Routine) {
    if (
      this.stopping ||
      this.sleeping ||
      this.mutations.has(snapshot.id) ||
      this.host.suspended ||
      this.settings.pausedUntil()
    )
      return;
    const current = this.repo.get(snapshot.id);
    const bot = current ? new BotsRepo(this.deps.db).get(current.botId) : undefined;
    if (
      !current ||
      current.version !== snapshot.version ||
      !current.enabled ||
      current.deletedAt ||
      current.pausedReason ||
      current.authorizationError ||
      !bot ||
      bot.archivedAt
    )
      return;
    return current;
  }
  private readonly schedule: RoutineSchedule;
  constructor(
    readonly deps: {
      db: DatabaseSync;
      agent?: AgentRuntime;
      dataDir: string;
      local: LocalService;
      runQueue: RunQueue;
      host: BrainHost;
      routineHost?: RoutineHostAdapter;
      peer: Peer<typeof Methods, typeof Events>;
      logger: Logger;
      redactor: BrainRedactor;
      credentials(provider: string): Promise<void>;
      dev?: boolean;
      routineDev?: import("./dev/dev.ts").RoutineDevAdapter;
    },
  ) {
    this.repo = new RoutinesRepo(deps.db);
    this.runs = new RoutineRunsRepo(deps.db);
    this.settings = new RoutineSettingsRepo(deps.db);
    this.triggers = new RoutineTriggersRepo(deps.db);
    this.execution = new RoutineExecution({
      ...deps,
      queue: deps.runQueue,
      changed: (r) => this.changedRun(r),
      completed: (r) => this.notify(r),
      canStart: (run) => {
        const reserved = run.conversationId
          ? this.runs.reservation(run.botId, run.conversationId)
          : undefined;
        if (reserved && reserved.id !== run.id) return false;
        if (run.reason === "manual" || run.reason === "trial")
          return !this.stopping && !this.sleeping;
        const routine = run.routineId ? this.repo.get(run.routineId) : undefined;
        return (
          !this.stopping &&
          !this.sleeping &&
          !this.mutations.has(run.routineId ?? "") &&
          !this.host.suspended &&
          !this.settings.pausedUntil() &&
          !!routine?.enabled &&
          !routine.pausedReason &&
          !routine.authorizationError &&
          !routine.deletedAt
        );
      },
      approvalWaitMs: () => this.timing.approvalWaitMs,
      approvalExpired: (id) =>
        deps.peer.emit("approval.resolved", { id, status: "expired", remembered: false }),
      routine: (id) => this.repo.get(id),
      authorizeRoutine: (routine) => this.authorizationReady(routine),
    });
    this.host = new RoutineHostService(this);
    this.authorization = new RoutineAuthorization(deps.local);
    this.appTriggers = new RoutineAppTriggers(this);
    this.schedule = new RoutineSchedule(this);
    if (deps.dev) this.timing.cronMinIntervalMs = 60000;
  }
  signal() {
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20000)]);
  }
  audit(kind: AuditEntry["kind"], routine: Routine, detail: AuditDetail = {}) {
    new AuditRepo(this.deps.db, this.deps.redactor).append({
      botId: routine.botId,
      kind,
      summary: kind,
      detail: { routineId: routine.id, source: "routine", actor: "user", ...detail },
    });
  }
  pause(routine: Routine, reason: Routine["pausedReason"]) {
    transaction(this.deps.db, () => {
      this.repo.pause(routine.id, reason);
      this.audit("routine.paused", routine, { actor: "system", reason: reason ?? "none" });
    });
  }
  setPausedUntil(until: string | null, actor: AuditDetail["actor"] = "user") {
    transaction(this.deps.db, () => {
      if (until) this.settings.pauseAll(until);
      else this.settings.resumeAll();
      for (const r of this.routines())
        if (r.enabled && !r.pausedReason)
          this.audit(until ? "routine.paused" : "routine.resumed", r, {
            actor,
            reason: "pause_all",
          });
    });
  }
  *routines() {
    let before: string | undefined;
    for (;;) {
      const page = this.repo.list({ before, limit: 200 });
      yield* page;
      if (page.length < 200) return;
      before = page.at(-1)?.id;
    }
  }
  changed(id?: string) {
    this.deps.peer.emit("routines.changed", id ? { id } : {});
    this.deps.peer.emit("inbox.changed", {});
  }
  changedRun(r: RoutineRun) {
    this.deps.peer.emit("routine.run", {
      routineId: r.routineId,
      routineRunId: r.id,
      runId: r.runId,
      botId: r.botId,
      status: r.status,
      conversationId: r.conversationId,
      messageId: r.runId ? (this.deps.runQueue.repo.get(r.runId)?.messageId ?? null) : null,
    });
    this.changed(r.routineId ?? undefined);
  }
  async notify(run: RoutineRun) {
    const routine = run.routineId ? this.repo.get(run.routineId) : null,
      draft = routine ?? run.trialDraft;
    if (
      !draft ||
      draft.notify === "never" ||
      // "Only when it needs me": a successful run notifies only if it marked itself
      // (routine_flag_attention); failures, timeouts and cancellations always notify.
      (draft.notify === "on_attention" && run.status === "done" && !run.attentionReason)
    )
      return;
    if (this.deps.host.notify)
      await abortable(
        this.deps.host.notify(
          {
            title: this.deps.redactor.redact(`Pi · ${draft.name}`),
            body: this.deps.redactor
              .redact(run.attentionReason || run.summary || run.errorCode || run.status)
              .slice(0, 80),
            botId: run.botId,
            routineRunId: run.id,
            ...(run.conversationId ? { conversationId: run.conversationId } : {}),
          },
          this.signal(),
        ),
        this.signal(),
      ).catch(() => this.deps.logger.warn("Routine notification unavailable"));
  }
  async create(input: RoutineDraftInput, trialRunId?: string) {
    const draft = await validateRoutine(
      this.deps.local,
      input,
      this.timing.cronMinIntervalMs,
      this.signal(),
      new Set(),
      this.deps.agent,
    );
    // Adding a monitor changes every tool's ceiling; stop old snapshots before association.
    const associated = this.deps.local.workplaces.repo.list(draft.botId);
    const changesBoundary = draft.triggers.some(
      (t) =>
        t.kind === "folder" &&
        !associated.folders.some((f) => f.path === t.path) &&
        associated.home !== t.path,
    );
    const release = changesBoundary ? await this.deps.runQueue.pauseBot(draft.botId) : () => {};
    let routine: Routine;
    try {
      const captured = await prepareAssociations(this.deps.local, draft, this.signal());
      routine = transaction(this.deps.db, () => {
        const boundary = commitAssociations(this.deps.local, draft, captured);
        validateNewOnce(draft);
        const created = this.repo.create(draft, boundary, this.trialTopic(trialRunId, draft.botId));
        this.audit("routine.created", created);
        return this.repo.require(created.id);
      });
    } finally {
      release();
    }
    this.changed(routine.id);
    await this.syncWatchers();
    return this.repo.require(routine.id);
  }
  async update(id: string, patch: RoutinePatch, version: number) {
    return this.withMutation(id, () => this.updateInside(id, patch, version));
  }
  private async updateInside(id: string, patch: RoutinePatch, version: number) {
    const old = this.require(id);
    if (old.version !== version) throw new RpcError(-32602, "Routine version changed");
    const merged = {
      ...old,
      ...patch,
      triggers: patch.triggers ?? old.triggers.map((t) => t.config),
      preauth:
        patch.botId && patch.botId !== old.botId
          ? []
          : (patch.preauth ?? old.preauth.map((p) => p.operation)),
    };
    const {
      id: _id,
      version: _version,
      pausedReason: _pause,
      lastScheduledAt: _watermark,
      topicConversationId: _topic,
      createdAt: _created,
      updatedAt: _updated,
      deletedAt: _deleted,
      authorizationError: _authorizationError,
      ...input
    } = merged;
    const retained = retainedPreauth(old, input);
    const draft = await validateRoutine(
      this.deps.local,
      input,
      this.timing.cronMinIntervalMs,
      this.signal(),
      retained,
      this.deps.agent,
    );
    await this.execution.cancelRoutine(
      id,
      patch.botId && patch.botId !== old.botId ? old.topicConversationId : undefined,
      this.signal(),
    );
    const associated = this.deps.local.workplaces.repo.list(draft.botId);
    const changesBoundary = draft.triggers.some(
      (t) =>
        t.kind === "folder" &&
        !associated.folders.some((f) => f.path === t.path) &&
        associated.home !== t.path,
    );
    const release = changesBoundary ? await this.deps.runQueue.pauseBot(draft.botId) : () => {};
    let result: Routine;
    try {
      const captured = await prepareAssociations(this.deps.local, draft, this.signal(), retained);
      result = transaction(this.deps.db, () => {
        const boundary = commitAssociations(this.deps.local, draft, captured, retained);
        const current = this.require(id);
        const commitVersion = routineMutationVersion(old, current);
        const closedDuringDrain = commitVersion !== version;
        const sameAppointment = draft.triggers.some(
          (t) =>
            t.kind === "once" &&
            old.triggers.some((v) => v.config.kind === "once" && v.config.at === t.at),
        );
        const enabled = closedDuringDrain && sameAppointment ? false : draft.enabled;
        validateNewOnce({ ...draft, enabled }, current);
        const updated = this.repo.update(
          id,
          closedDuringDrain ? { ...patch, enabled } : patch,
          commitVersion,
          boundary,
        );
        this.audit("routine.updated", updated);
        return updated;
      });
    } finally {
      release();
    }
    this.resumedOnce(old, result);
    this.changed(id);
    await this.syncWatchers();
    return this.repo.require(result.id);
  }
  require(id: string) {
    const r = this.repo.get(id);
    if (!r || r.deletedAt) throw new RpcError(-32602, "Unknown routine");
    return r;
  }
  async remove(id: string) {
    return this.withMutation(id, () => this.removeInside(id));
  }
  private async removeInside(id: string) {
    const r = this.require(id);
    await this.execution.cancelRoutine(id, r.topicConversationId, this.signal());
    transaction(this.deps.db, () => {
      this.repo.softDelete(id);
      this.onceRecovery.delete(id);
      this.invalidAuthorization.delete(id);
      this.audit("routine.deleted", r);
    });
    this.changed(id);
    await this.syncWatchers();
  }
  async runNow(id: string) {
    const routine = this.require(id);
    if (!(await this.authorizationReady(routine)))
      throw new RpcError(
        RpcErrorCodes.routineReauthorizationRequired,
        "routine_preauth_reauthorization_required",
      );
    await this.assertImageSchedule(routine.botId);
    const r = this.runs.enqueue(
      {
        routineId: id,
        botId: routine.botId,
        triggerId: null,
        reason: "manual",
        scheduledFor: new Date().toISOString(),
        // Deliberately not deduped: a second click is a second run, so the key must never collide.
        dedupeKey: `manual:${randomUUID()}`,
      },
      this.timing.queueWaitMs,
    );
    await this.publish(r, routine);
    return { runId: r.id };
  }
  /**
   * The user continues a failed, timed-out or stopped run. The resume is the same occurrence
   * (same period folder, same send idempotency keys), starts a fresh session with the ledger of
   * the earlier attempts, and is never automatic. Each run is resumed at most once (dedupe key and
   * unique index); a chain of resumes is capped so a broken task cannot loop forever.
   */
  async resumeRun(id: string) {
    const previous = this.runs.get(id);
    if (
      !previous?.routineId ||
      previous.reason === "trial" ||
      !["failed", "timeout", "cancelled"].includes(previous.status)
    )
      throw new RpcError(-32602, "routine_resume_unavailable");
    const routine = this.require(previous.routineId);
    if (routine.deletedAt) throw new RpcError(-32602, "routine_resume_unavailable");
    if (!(await this.authorizationReady(routine)))
      throw new RpcError(
        RpcErrorCodes.routineReauthorizationRequired,
        "routine_preauth_reauthorization_required",
      );
    if (this.runs.attempts(previous.occurrenceId ?? previous.id).length > MAX_RESUMES)
      throw new RpcError(-32602, "routine_resume_limit");
    // A skipped_overlap row would hold the dedupe key and block this resume for good.
    if (this.runs.hasActive(routine.id)) throw new RpcError(-32011, "busy");
    await this.assertImageSchedule(routine.botId);
    const r = this.runs.enqueue(
      {
        routineId: routine.id,
        botId: routine.botId,
        triggerId: null,
        reason: "manual",
        scheduledFor: previous.scheduledFor,
        dedupeKey: `resume:${previous.id}`,
        resumeOf: previous.id,
      },
      this.timing.queueWaitMs,
    );
    await this.publish(r, routine);
    return { runId: r.id };
  }
  /** A finished-or-running trial of the same Bot hands its conversation to the new task. */
  private trialTopic(trialRunId: string | undefined, botId: string) {
    if (!trialRunId) return undefined;
    const trial = this.runs.get(trialRunId);
    return trial?.reason === "trial" && !trial.routineId && trial.botId === botId
      ? (trial.conversationId ?? undefined)
      : undefined;
  }
  async trial(input: RoutineDraftInput) {
    const draft = await validateRoutine(
      this.deps.local,
      input,
      this.timing.cronMinIntervalMs,
      this.signal(),
      new Set(),
      this.deps.agent,
    );
    const r = this.runs.enqueue(
      {
        routineId: null,
        botId: draft.botId,
        triggerId: null,
        reason: "trial",
        scheduledFor: new Date().toISOString(),
        // Deliberately not deduped: every trial is its own run, so the key must never collide.
        dedupeKey: `trial:${randomUUID()}`,
        trialDraft: draft,
      },
      this.timing.queueWaitMs,
    );
    await this.publish(r);
    return { runId: r.id };
  }
  async authorizationReady(routine: Routine) {
    this.lifetime.signal.throwIfAborted();
    const annotated = routine.authorizationError
      ? routine
      : await this.authorization.annotate(routine, this.lifetime.signal);
    this.lifetime.signal.throwIfAborted();
    if (!annotated.authorizationError) {
      this.invalidAuthorization.delete(routine.id);
      return true;
    }
    if (this.invalidAuthorization.get(routine.id) !== routine.version) {
      this.audit("policy.denied", routine, {
        actor: "system",
        reasonCode: "routine_preauth_reauthorization_required",
      });
      this.invalidAuthorization.set(routine.id, routine.version);
    }
    return false;
  }
  async publish(r: RoutineRun, routine?: Routine, changes?: { paths: string[]; total: number }) {
    if (this.activity?.() === false) throw new RpcError(-32001, "brain_sleep_committed");
    if (r.status !== "scheduled") {
      this.changedRun(r);
      return;
    }
    try {
      await this.execution.publish(r, routine, undefined, changes);
    } catch (e) {
      if (e instanceof RpcError && e.code === -32011) return;
      this.execution.finish(r.id, "failed", "routine_prepare_failed");
      this.deps.logger.warn(`Routine preparation failed run=${r.id}`);
    }
  }
  async start() {
    const recovered = this.runs.recover();
    // A legacy terminal appointment may be closed without counting as an interrupted run.
    if (recovered || this.repo.list({ limit: 1 }).length) this.changed();
    this.graceUntil = Date.now() + this.timing.resumeGraceMs;
    if (!this.settings.lastUiActiveAt()) this.settings.uiActive(new Date().toISOString());
    // Startup focus is evidence of returning, not evidence that the preceding absence never happened.
    await this.host.checkAway(Date.now(), true);
    // Retired workflow bindings are settled before anything is scheduled from them.
    await retireRoutineWorkflows(this, this.lifetime.signal).catch((error: unknown) => {
      if (this.lifetime.signal.aborted) throw error;
      this.deps.logger.warn("Routine workflow retirement deferred");
    });
    this.host.start();
    await this.tick();
    this.armTimer();
  }
  private armTimer() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.ticking || this.stopping || this.sleeping) return;
      this.ticking = true;
      void this.queue
        .submit(() => this.tick())
        .catch(() => this.deps.logger.warn("Routine scheduler tick deferred"))
        .finally(() => {
          this.ticking = false;
        });
    }, 1000);
  }
  automationIdle() {
    return (
      !this.ticking && this.mutations.size === 0 && this.queue.isIdle() && this.appTriggers.isIdle()
    );
  }
  async pauseAutomation() {
    this.sleeping = true;
    clearInterval(this.timer);
    await this.queue.drain();
    await this.appTriggers.cancel();
    await this.schedule.stop();
  }
  async resumeAutomation() {
    if (this.stopping) return;
    this.sleeping = false;
    this.recovered();
    this.armTimer();
    await this.queue.submit(() => this.tick());
  }
  async syncWatchers() {
    await this.schedule.syncWatchers();
  }
  async setEnabled(id: string, enabled: boolean) {
    return this.withMutation(id, () => this.setEnabledInside(id, enabled));
  }
  private async setEnabledInside(id: string, enabled: boolean) {
    const r = this.require(id);
    if (enabled) {
      if (!r.triggers.length) throw new RpcError(-32602, "routine_trigger_missing");
      // The same gate as saving, so a retired GitHub trigger or a connection, check or
      // calendar that is no longer usable fails here, not as a trigger error a scan later.
      for (const t of r.triggers) appTriggerIssue(this.deps.local, r.botId, t.config);
      await this.assertImageSchedule(r.botId);
    }
    if (
      enabled &&
      r.triggers.length === 1 &&
      r.triggers[0]?.config.kind === "once" &&
      r.triggers[0].state.consumedAt
    )
      throw new RpcError(-32602, "routine_once_consumed");
    if (!enabled) await this.execution.cancelRoutine(id, undefined, this.signal());
    else await this.schedule.baseline(r);
    transaction(this.deps.db, () => {
      const current = this.require(id);
      routineMutationVersion(r, current);
      if (current.enabled !== enabled) this.repo.setEnabled(id, enabled);
      if (enabled) this.repo.pause(id, null);
      this.audit(enabled ? "routine.resumed" : "routine.paused", r);
    });
    this.resumedOnce(r, this.repo.require(id));
    this.changed(id);
    await this.syncWatchers();
    return this.repo.require(id);
  }
  async resumeAway(ids?: string[]) {
    const wanted = ids ? new Set(ids) : null;
    if (wanted)
      for (const id of wanted) {
        const routine = this.repo.get(id);
        if (routine) await this.assertImageSchedule(routine.botId);
      }
    const resumed: Routine[] = [];
    for (const r of this.routines())
      if (r.pausedReason === "away_7d" && (!wanted || wanted.has(r.id))) {
        try {
          await this.assertImageSchedule(r.botId);
          await this.schedule.baseline(r);
          resumed.push(r);
        } catch {
          this.lifetime.signal.throwIfAborted();
          this.pause(r, "trigger_error");
        }
      }
    transaction(this.deps.db, () => {
      for (let offset = 0; offset < resumed.length; offset += 200)
        this.repo.resumeAway(resumed.slice(offset, offset + 200).map((routine) => routine.id));
      for (const r of resumed) {
        this.resumedOnce(r, this.repo.require(r.id));
        this.audit("routine.resumed", r, { reason: "resume_away" });
      }
    });
    this.changed();
    await this.syncWatchers();
  }
  recovered() {
    this.recovery = true;
    this.graceUntil = Date.now() + this.timing.resumeGraceMs;
    this.execution.power(false);
  }
  private async assertImageSchedule(botId: string) {
    const bot = new BotsRepo(this.deps.db).get(botId);
    if (bot?.category !== "image") return;
    if (!this.deps.agent) throw new RpcError(-32602, "image_model_unavailable");
    await requireImageModel(
      this.deps.local.images,
      bot.modelProvider && bot.modelId
        ? { provider: bot.modelProvider, id: bot.modelId }
        : undefined,
      "text-to-image",
      this.signal(),
    );
  }
  async resumeAll(actor: AuditDetail["actor"] = "user") {
    const signal = this.signal();
    const paused = this.settings.pausedUntil();
    if (paused) {
      // User-paused periods are not sleep misses. After an expired pause, retain eligible later cron points.
      const resumedAt = Date.now(),
        expiresAt = Date.parse(paused),
        cutoff = Math.min(resumedAt, expiresAt);
      for (const r of this.routines())
        if (r.enabled && !r.pausedReason) {
          try {
            signal.throwIfAborted();
            await this.schedule.baseline(r, cutoff, signal, expiresAt <= resumedAt);
          } catch {
            signal.throwIfAborted();
            this.deps.logger.warn("Paused routine baseline unavailable");
            this.pause(r, "trigger_error");
            this.changed(r.id);
          }
        }
    }
    this.setPausedUntil(null, actor);
    this.recovered();
    this.changed();
  }
  async tick() {
    if (this.stopping || this.sleeping) return;
    const now = Date.now();
    const paused = this.settings.pausedUntil();
    if (paused && Date.parse(paused) <= now) {
      await this.resumeAll("automatic");
    }
    await this.host.checkAway(now);
    this.proposals?.refresh();
    await this.execution.pollWaiting(this.signal());
    if (this.host.suspended || this.settings.pausedUntil()) {
      await this.syncWatchers();
      await this.host.refresh();
      return;
    }
    const polling = this.schedule.pollingRoutines(now);
    const scan =
      polling.size > 0 ||
      this.recovery ||
      this.onceRecovery.size > 0 ||
      performance.now() - this.lastMonotonicTick >= 15000;
    if (scan) {
      const missed = this.recovery || (this.lastTick > 0 && now - this.lastTick > 90000);
      for (const r of this.routines()) {
        this.lifetime.signal.throwIfAborted();
        if (new BotsRepo(this.deps.db).get(r.botId)?.archivedAt) {
          this.onceRecovery.delete(r.id);
          if (r.pausedReason !== "bot_archived") {
            this.pause(r, "bot_archived");
            this.changed(r.id);
          }
          continue;
        }
        if (!r.enabled || r.pausedReason) {
          this.onceRecovery.delete(r.id);
          continue;
        }
        if (this.mutations.has(r.id)) continue;
        if (r.authorizationError && !(await this.authorizationReady(r))) continue;
        this.appTriggers.schedule(r, now);
        if (r.triggers.some((t) => t.config.kind === "once"))
          await scheduleOnce(this, r, now, missed || this.onceRecovery.has(r.id));
        else await this.schedule.cron(r, now, missed, missed || polling.has(r.id));
        this.onceRecovery.delete(r.id);
      }
      this.recovery = false;
      this.lastTick = now;
      this.lastMonotonicTick = performance.now();
      await this.syncWatchers();
    }
    // Pages are newest first; publish oldest first so one Bot's runs queue in firing order.
    const scheduled = [];
    for await (const r of routineRunPages(this.runs, "scheduled", this.signal())) scheduled.push(r);
    for (const r of scheduled.reverse()) {
      if (r.queueExpiresAt && Date.parse(r.queueExpiresAt) <= now) {
        if (r.runId) await this.deps.runQueue.abort(r.runId, "queue_timeout", { code: "timeout" });
        this.execution.finish(r.id, "failed", "queue_timeout");
        this.changedRun(this.runs.require(r.id));
        continue;
      }
      // Persisted queue time bounds grace without one in-memory timer/map entry per missed run.
      if (
        r.reason === "catchup" &&
        now <
          Math.max(
            this.graceUntil,
            Date.parse(r.queuedAt ?? r.createdAt) + this.timing.resumeGraceMs,
          )
      )
        continue;
      if (r.waitCheckpoint) {
        await this.execution.resumeScheduled(r, this.signal());
        continue;
      }
      await this.publish(r, r.routineId ? this.repo.get(r.routineId) : undefined);
    }
    await this.host.refresh();
  }
  next() {
    return this.schedule.next();
  }
  pollingAt() {
    return this.schedule.pollingAt();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.host.unsubscribe();
    this.lifetime.abort();
    await this.appTriggers.cancel();
    // Retain ownership on timeout; never close SQLite while a watcher/consumer still uses it.
    await abortable(this.schedule.stop(), AbortSignal.timeout(10000));
    await abortable(this.queue.stop(), AbortSignal.timeout(10000));
    await this.deps.runQueue.cancel((r) => r.kind === "routine", "cancelled");
    // Manifests in progress write to SQLite; finish them before the database closes.
    await abortable(this.execution.drainLedger(), AbortSignal.timeout(10000));
    await this.host.stop();
  }
}
