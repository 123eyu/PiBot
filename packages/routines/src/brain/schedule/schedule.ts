import { join } from "node:path";
import type { Routine, RoutineRun, RoutineTrigger, RoutineTriggerState } from "@pibot/protocol";
import { latestCron, nextCron, scanFolder, snapshotChanges, watchFolder } from "@pibot/scheduler";
import { transaction } from "@pibot/storage";
import { RoutineSchedulerStateRepo } from "../../store/index.ts";
import type { RoutineService } from "../service.ts";

export class RoutineSchedule {
  private readonly watchers = new Map<
    string,
    { config: string; failed?: boolean; stop(): Promise<void> }
  >();
  private readonly polling = new Map<string, { config: string; routineId: string; at: number }>();
  pollingAt() {
    let at = Infinity;
    for (const item of this.polling.values()) at = Math.min(at, item.at);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  /**
   * A running watcher already reports this folder and owns its checkpoint. Rescanning it after a
   * wall-clock jump would rewrite that checkpoint and fail the watcher's next compare-and-set.
   */
  private liveWatcher(triggerId: string) {
    const watcher = this.watchers.get(triggerId);
    return !!watcher && !watcher.failed;
  }
  pollingRoutines(now: number) {
    const ids = new Set<string>();
    for (const item of this.polling.values()) if (item.at <= now) ids.add(item.routineId);
    return ids;
  }
  private async defer(r: Routine, t: RoutineTrigger) {
    const current = this.service.scheduleCurrent(r),
      trigger = current?.triggers.find((v) => v.id === t.id);
    if (!current || !trigger || trigger.config.kind !== "folder") return;
    try {
      // Native capacity says nothing about directory safety, even with an older complete baseline.
      const snapshot = await scanFolder(
        trigger.config,
        this.service.deps.dataDir,
        this.service.signal(),
        Date.now(),
      );
      if (!this.service.scheduleCurrent(current)) return;
      // Existing baselines retain unconsumed changes; only first registration may establish a new one.
      if (
        !trigger.state.snapshot?.complete &&
        !this.service.triggers.checkpoint(trigger.id, trigger.state, { ...trigger.state, snapshot })
      )
        throw new Error("watch_checkpoint_changed");
      this.polling.set(t.id, {
        routineId: r.id,
        config: JSON.stringify([r.botId, trigger.config]),
        at: Date.now() + 900000,
      });
    } catch {
      this.pauseFailure(current, trigger);
    }
  }
  private pauseFailure(r: Routine, t: RoutineTrigger) {
    if (!this.service.scheduleCurrent(r)) return;
    this.polling.delete(t.id);
    this.service.pause(r, "trigger_error");
    this.service.changed(r.id);
  }
  private async watchFailure(r: Routine, t: RoutineTrigger, reason: string) {
    if (
      [
        "watch_capacity",
        "watch_ENOSPC",
        "watch_EMFILE",
        "watch_start_timeout",
        "watch_unavailable",
        "watch_env_override",
      ].includes(reason)
    )
      await this.defer(r, t);
    else this.pauseFailure(r, t);
  }
  constructor(private readonly service: RoutineService) {}
  async baseline(
    r: Routine,
    cronAt = Date.now(),
    signal = this.service.signal(),
    expiredPause = false,
  ) {
    const now = new Date(
      Math.max(cronAt, Date.parse(r.lastScheduledAt ?? r.createdAt)),
    ).toISOString();
    const updates: { t: RoutineTrigger; next: RoutineTriggerState }[] = [];
    for (const t of r.triggers) {
      signal.throwIfAborted();
      if (t.config.kind === "once" || t.config.kind === "github") continue;
      // Forgetting what was seen makes the next check run right away as a baseline, so a
      // connection or "new event" trigger never fires for what changed while the task was off.
      // "Before start" keeps its state (what it already fired for): an event whose reminder moment
      // came while the task was off and that has not started yet still fires once on resume.
      if (
        t.config.kind === "connection" ||
        (t.config.kind === "calendar" && t.config.event === "new_event")
      ) {
        const { connection: _connection, calendar: _calendar, ...rest } = t.state;
        updates.push({ t, next: rest });
        continue;
      }
      if (t.config.kind === "calendar") continue;
      updates.push({
        t,
        next:
          t.config.kind === "cron"
            ? {
                ...t.state,
                lastScheduledAt: new Date(
                  Math.max(Date.parse(now), Date.parse(t.state.lastScheduledAt ?? t.createdAt)),
                ).toISOString(),
              }
            : {
                ...t.state,
                snapshot: await scanFolder(
                  t.config,
                  this.service.deps.dataDir,
                  signal,
                  Date.now(),
                  expiredPause
                    ? {
                        after: Math.max(cronAt, Date.parse(t.createdAt)),
                        previous: t.state.snapshot,
                      }
                    : undefined,
                ),
                pendingPaths: [],
                pendingCount: 0,
              },
      });
    }
    transaction(this.service.deps.db, () => {
      for (const { t, next } of updates)
        if (!this.service.triggers.checkpoint(t.id, t.state, next))
          throw new Error("trigger_baseline_changed");
      this.service.repo.watermark(r.id, now);
    });
  }
  async syncWatchers() {
    if (this.service.sleeping) return;
    const desired = new Map<string, { r: Routine; t: RoutineTrigger }>();
    const paused = !!this.service.settings.pausedUntil() || this.service.host.suspended;
    for (const r of this.service.routines())
      if (
        r.enabled &&
        !r.pausedReason &&
        !r.authorizationError &&
        !paused &&
        !this.service.isMutating(r.id)
      )
        for (const t of r.triggers) if (t.config.kind === "folder") desired.set(t.id, { r, t });
    for (const [id, p] of this.polling)
      if (
        !desired.has(id) ||
        JSON.stringify([desired.get(id)?.r.botId, desired.get(id)?.t.config]) !== p.config
      )
        this.polling.delete(id);
    for (const [id, w] of this.watchers)
      if (
        w.failed ||
        !desired.has(id) ||
        JSON.stringify([desired.get(id)?.r.botId, desired.get(id)?.t.config]) !== w.config
      ) {
        await w.stop();
        if (this.watchers.get(id) === w) this.watchers.delete(id);
      }
    for (const [id, { r, t }] of desired) {
      // `desired` was built before the preceding recovery scan. Refresh the trigger state before
      // constructing a native watcher: otherwise its private baseline can lag behind the scan,
      // and the first native callback can enqueue the same file facts a second time.
      const current = this.service.scheduleCurrent(r),
        fresh = current && this.service.repo.get(current.id),
        freshTrigger = fresh?.triggers.find((value) => value.id === t.id);
      if (!fresh || !freshTrigger || freshTrigger.config.kind !== "folder") continue;
      if (this.watchers.has(id)) continue;
      if ((this.polling.get(id)?.at ?? 0) > Date.now()) continue;
      if (this.watchers.size >= 64) {
        await this.defer(fresh, freshTrigger);
        continue;
      }
      try {
        const watcher = await watchFolder({
          trigger: freshTrigger as Parameters<typeof watchFolder>[0]["trigger"],
          dataDir: this.service.deps.dataDir,
          signal: this.service.lifetime.signal,
          now: Date.now,
          checkpoint: async (expected, next, paths, total) => {
            if (
              this.service.stopping ||
              this.service.sleeping ||
              this.service.host.suspended ||
              this.service.settings.pausedUntil()
            )
              return false;
            let run: RoutineRun | undefined;
            const accepted = transaction(this.service.deps.db, () => {
              const current = this.service.scheduleCurrent(this.service.repo.require(fresh.id));
              if (current?.botId !== fresh.botId || !current?.triggers.some((v) => v.id === id))
                return false;
              if (!current || current.deletedAt || !current.enabled || current.pausedReason)
                return false;
              if (!this.service.triggers.checkpoint(id, expected, next))
                throw new Error("watch_checkpoint_changed");
              if (total) {
                run = this.service.runs.enqueue(
                  {
                    routineId: fresh.id,
                    botId: fresh.botId,
                    triggerId: id,
                    reason: "folder",
                    scheduledFor: next.lastTriggeredAt as string,
                    dedupeKey: `folder:${id}:${next.lastTriggeredAt}`,
                  },
                  this.service.timing.queueWaitMs,
                );
                if (run.status === "scheduled")
                  this.service.execution.triggerMessages.ensure(run, current, { paths, total });
              }
              return true;
            });
            if (!accepted) return false;
            if (run) {
              await this.service.publish(run, this.service.repo.require(fresh.id));
            }
            return true;
          },
          error: async (reason) => {
            const owned = this.watchers.get(id);
            if (owned) owned.failed = true;
            this.service.activity?.();
            try {
              await this.watchFailure(fresh, freshTrigger, reason);
            } finally {
              // stop waits for this callback; retain ownership and observe it without awaiting ourselves.
              if (owned)
                void owned
                  .stop()
                  .then(() => {
                    if (this.watchers.get(id) === owned) this.watchers.delete(id);
                  })
                  .catch(() => {
                    this.service.deps.logger.error("Routine watcher cleanup failed");
                  });
            }
          },
        });
        this.watchers.set(id, {
          ...watcher,
          config: JSON.stringify([fresh.botId, freshTrigger.config]),
        });
        this.polling.delete(id);
      } catch (error) {
        // A preflight overtaken by pause/edit created no native watcher; the next sync retries fresh state.
        if (error instanceof Error && error.message === "watch_checkpoint_deferred") continue;
        await this.watchFailure(
          fresh,
          freshTrigger,
          error instanceof Error ? error.message : "watch_io_error",
        );
      }
    }
  }
  async cron(r: Routine, now: number, missed: boolean, scanFolders = missed) {
    const states: {
      t: RoutineTrigger;
      next: RoutineTriggerState;
      occurrence: number | null;
      changes?: { paths: string[]; total: number };
    }[] = [];
    for (const t of r.triggers)
      if (t.config.kind === "cron") {
        const from = Date.parse(t.state.lastScheduledAt ?? r.lastScheduledAt ?? t.createdAt);
        if (now <= from) continue; // Wall-clock rollback cannot replay an already consumed occurrence.
        const occurrence = await latestCron(
          t.config.expr,
          t.config.timezone,
          from,
          now,
          this.service.signal(),
        );
        states.push({
          t,
          next: { ...t.state, lastScheduledAt: new Date(now).toISOString() },
          occurrence,
        });
      } else if (t.config.kind === "folder" && scanFolders && !this.liveWatcher(t.id)) {
        const config = t.config;
        try {
          const snapshot = await scanFolder(
            t.config,
            this.service.deps.dataDir,
            this.service.signal(),
            now,
          );
          const changes = snapshotChanges(
            t.state.snapshot,
            snapshot,
            t.config.events === "new_and_changed",
          );
          const hasChanges = changes.length > 0 || (t.state.pendingCount ?? 0) > 0;
          const cooling =
            t.state.lastTriggeredAt &&
            now - Date.parse(t.state.lastTriggeredAt) < t.config.cooldownMin * 60000;
          // File mtime is an observation fact, never a cron missed-run timestamp.
          const occurrence = hasChanges && !cooling ? now : null;
          states.push({
            t,
            occurrence,
            changes: {
              paths: [
                ...new Set([
                  ...changes.map((p) => join(config.path, p)),
                  ...(t.state.pendingPaths ?? []),
                ]),
              ],
              total: Math.max(changes.length, t.state.pendingCount ?? 0),
            },
            next: {
              ...t.state,
              snapshot: cooling && t.state.snapshot ? t.state.snapshot : snapshot,
              pendingPaths: cooling
                ? [
                    ...new Set([
                      ...(t.state.pendingPaths ?? []),
                      ...changes.slice(0, 50).map((p) => join(config.path, p)),
                    ]),
                  ].slice(0, 50)
                : [],
              pendingCount: cooling ? Math.max(t.state.pendingCount ?? 0, changes.length) : 0,
              ...(occurrence !== null ? { lastTriggeredAt: new Date(now).toISOString() } : {}),
            },
          });
        } catch {
          this.service.pause(r, "trigger_error");
          this.service.changed(r.id);
          return;
        }
      }
    const folders = states.filter((s) => s.t.config.kind === "folder" && s.occurrence !== null);
    const latest =
      folders[0] ??
      states
        .filter((s) => s.t.config.kind === "cron" && s.occurrence !== null)
        .sort((a, b) => (b.occurrence as number) - (a.occurrence as number))[0];
    // Coalesce all observed folders with this tick's cron, without losing file facts or running twice.
    const paths = new Set<string>();
    let omitted = 0;
    for (const folder of folders) {
      for (const path of folder.changes?.paths ?? []) {
        paths.add(path);
        if (paths.size > 10000) {
          this.service.pause(r, "trigger_error");
          this.service.changed(r.id);
          return;
        }
      }
      omitted += Math.max(0, (folder.changes?.total ?? 0) - (folder.changes?.paths.length ?? 0));
    }
    const changes = folders.length
      ? { paths: [...paths].slice(0, 50), total: paths.size + omitted }
      : undefined;
    let run: RoutineRun | undefined;
    transaction(this.service.deps.db, () => {
      if (!this.service.scheduleCurrent(r)) return;
      for (const s of states)
        if (!this.service.triggers.checkpoint(s.t.id, s.t.state, s.next))
          throw new Error("cron_checkpoint_changed");
      this.service.repo.watermark(r.id, new Date(now).toISOString());
      if (!latest) return;
      const policy = r.missedPolicy ?? this.service.settings.get().missedPolicy;
      const cronMissed = missed && latest.t.config.kind === "cron";
      const tooOld =
        cronMissed && now - (latest.occurrence as number) > this.service.timing.missedMaxAgeMs;
      const status = cronMissed
        ? tooOld || policy === "skip"
          ? "skipped_missed"
          : policy === "ask"
            ? "missed"
            : "scheduled"
        : "scheduled";
      run = this.service.runs.enqueue(
        {
          routineId: r.id,
          botId: r.botId,
          triggerId: latest.t.id,
          reason: cronMissed && policy === "catchup" && !tooOld ? "catchup" : latest.t.config.kind,
          scheduledFor: new Date(latest.occurrence as number).toISOString(),
          dedupeKey: `${latest.t.config.kind}:${latest.t.id}:${latest.t.config.kind === "folder" ? latest.next.lastTriggeredAt : latest.occurrence}`,
          status,
        },
        this.service.timing.queueWaitMs,
      );
      if (changes && run.status === "scheduled")
        this.service.execution.triggerMessages.ensure(run, r, changes);
      if (tooOld) new RoutineSchedulerStateRepo(this.service.deps.db).markMissedTooOld(run.id);
    });
    if (run) {
      this.service.changedRun(this.service.runs.require(run.id));
      if (!missed || run.reason === "folder") await this.service.publish(run, r);
    }
  }
  next() {
    let next: { routineId: string; name: string; at: string; conversationId: string } | null = null;
    if (this.service.settings.pausedUntil()) return null;
    for (const r of this.service.routines())
      if (r.enabled && !r.pausedReason && !r.authorizationError)
        for (const t of r.triggers)
          if (t.config.kind === "cron" || (t.config.kind === "once" && !t.state.consumedAt)) {
            const at =
              t.config.kind === "once"
                ? t.config.at
                : new Date(
                    nextCron(
                      t.config.expr,
                      t.config.timezone,
                      Math.max(Date.now(), Date.parse(t.state.lastScheduledAt ?? r.createdAt)),
                    ),
                  ).toISOString();
            if (!next || at < next.at)
              next = { routineId: r.id, name: r.name, at, conversationId: r.topicConversationId };
          }
    return next;
  }
  async stop() {
    await Promise.all([...this.watchers.values()].map((w) => w.stop()));
    this.watchers.clear();
  }
}
