import { randomUUID } from "node:crypto";
import { abortable } from "@pibot/brain/kit";
import {
  RoutineControlSchema,
  type RoutineSummarySchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { BotsRepo, PowerEventsRepo } from "@pibot/storage";
import type { RoutineService } from "./service.ts";

// The host refuses a brain whose epoch it ended (replacement, quit) with `closed`. It has already
// dropped that epoch's keep-awake lease and cleared the tray, so there is nothing left to do.
const epochEnded = (error: unknown) =>
  error instanceof RpcError && error.code === RpcErrorCodes.closed;
// Host error messages are protocol identifiers; anything else is reduced to its class name.
function failureLabel(error: unknown) {
  if (error instanceof RpcError)
    return /^[a-z][a-z0-9_]{0,63}$/.test(error.message)
      ? `rpc ${error.code} ${error.message}`
      : `rpc ${error.code}`;
  return error instanceof Error ? error.name : typeof error;
}

export class RoutineHostService {
  suspended = false;
  private supply: "ac" | "battery" | "unknown" = "unknown";
  private keepAwake: "off" | "requested" | "unsupported" = "unsupported";
  private unsubscriptions: (() => void)[] = [];
  private nextAway = 0;
  private lastUiWrite = 0;
  private refreshedAt = -Infinity;
  private waitingSince: number | null = null;
  private readonly leaseId = randomUUID();
  constructor(private readonly service: RoutineService) {}
  start() {
    const namespace = this.service.deps.routineHost;
    if (!namespace) return;
    this.unsubscriptions.push(
      namespace.onControl((input) => {
        if (this.service.activity?.() === false)
          return Promise.reject(new RpcError(-32001, "brain_sleep_committed"));
        return this.service.queue.submit(async () =>
          this.control(RoutineControlSchema.parse(input)),
        );
      }),
    );
    // Production does not import a dev adapter. Trusted desktop/Node construction supplies it.
    if (this.service.deps.dev && this.service.deps.routineDev && namespace.onDevControl) {
      const listener = this.service.deps.routineDev(this.service);
      this.unsubscriptions.push(
        namespace.onDevControl((input) => {
          if (this.service.activity?.() === false)
            return Promise.reject(new RpcError(-32001, "brain_sleep_committed"));
          return this.service.queue.submit(() => listener(input));
        }),
      );
    }
  }
  async control(input: import("zod").infer<typeof RoutineControlSchema>) {
    const s = this.service;
    if (input.type === "ui-active") {
      if (Date.parse(input.at) > Date.now() + 60000) throw new Error("future_ui_activity");
      if (Date.parse(input.at) - this.lastUiWrite >= 3600000) {
        s.settings.uiActive(input.at);
        this.lastUiWrite = Date.parse(input.at);
      }
    } else if (input.type === "routines-pause") {
      s.setPausedUntil(input.until);
      s.changed();
      await s.syncWatchers();
    } else if (input.type === "routines-resume") {
      await s.resumeAll();
      await s.tick();
    } else if (input.type === "power-snapshot") {
      this.supply = input.supply;
      this.keepAwake = input.keepAwake;
      this.emit(input.at);
    } else {
      new PowerEventsRepo(s.deps.db).append(input.event);
      this.supply = input.supply;
      if (input.event.kind === "suspend") {
        this.suspended = true;
        s.execution.power(true);
        await s.syncWatchers();
      }
      if (input.event.kind === "resume") {
        this.suspended = false;
        s.recovered();
        await s.tick();
      }
      this.emit(input.event.at);
    }
    this.refreshedAt = -Infinity;
    await this.refresh();
  }
  private emit(at: string) {
    this.service.deps.peer.emit("power.state", {
      state: this.suspended ? "suspended" : "awake",
      supply: this.supply,
      keepAwake: this.keepAwake,
      at,
    });
  }
  async checkAway(now: number, force = false) {
    if (!force && performance.now() < this.nextAway) return;
    this.nextAway = performance.now() + this.service.timing.awayCheckMs;
    new PowerEventsRepo(this.service.deps.db).prune(new Date(now).toISOString());
    const settings = this.service.settings,
      lastActive = settings.lastUiActiveAt();
    if (
      !settings.get().pauseWhenAway ||
      !lastActive ||
      now - Date.parse(lastActive) < this.service.timing.awayAfterMs
    )
      return;
    let count = 0;
    for (const r of this.service.routines())
      if (r.enabled && !r.pausedReason) {
        this.service.pause(r, "away_7d");
        count++;
      }
    if (count) {
      this.service.changed();
      const botId = new BotsRepo(this.service.deps.db).getMain()?.id;
      if (botId)
        await this.service.deps.host
          .notify?.(
            {
              title: "Pi Bot",
              botId,
              body: "你 7 天没打开 Pi Bot，例行任务已暂停 / Routines paused after 7 days away",
            },
            this.service.signal(),
          )
          .catch(() => this.service.deps.logger.warn("Away notification unavailable"));
    }
  }
  async summary(): Promise<import("zod").infer<typeof RoutineSummarySchema>> {
    const s = this.service,
      signal = s.signal();
    const background = s.deps.routineHost
      ? await abortable(s.deps.routineHost.backgroundState(signal), signal)
      : {
          state: "stopped" as const,
          startedAt: null,
          uptimeMs: 0,
          restartCount: 0,
          at: new Date().toISOString(),
        };
    return {
      counts: s.repo.counts(),
      next: s.next(),
      pausedUntil: s.settings.pausedUntil(),
      background,
      at: new Date().toISOString(),
    };
  }
  async refresh() {
    const s = this.service,
      namespace = s.deps.routineHost,
      now = Date.now();
    if (!namespace || performance.now() - this.refreshedAt < 10000) return;
    const counts = s.repo.counts(),
      next = s.next(),
      settings = s.settings.get();
    if (counts.waiting && this.waitingSince === null) {
      const at = s.runs.oldestWaitingAt();
      const oldest = at ? Math.max(0, now - Date.parse(at)) : 0;
      this.waitingSince = performance.now() - Math.min(s.timing.waitingKeepAwakeMs, oldest);
    }
    if (!counts.waiting) this.waitingSince = null;
    const reason = counts.running
      ? "running"
      : counts.waiting &&
          performance.now() - (this.waitingSince ?? performance.now()) < s.timing.waitingKeepAwakeMs
        ? "waiting"
        : next && Date.parse(next.at) - now <= 120000
          ? "upcoming"
          : "none";
    const signal = s.signal();
    try {
      const lease = await abortable(
        namespace.keepAwake(
          {
            mode: this.suspended ? "never" : settings.keepAwake,
            reason,
            leaseId: this.leaseId,
            leaseMs: 30000,
          },
          signal,
        ),
        signal,
      );
      this.keepAwake = lease.status;
      const running = [
        ...s.runs.page("running", { limit: 20 }),
        ...s.runs.page("waiting", { limit: 20 }),
      ]
        .slice(0, 20)
        .flatMap((r) => {
          const routine = r.routineId ? s.repo.get(r.routineId) : null;
          return r.runId
            ? [
                {
                  routineId: r.routineId,
                  routineRunId: r.id,
                  runId: r.runId,
                  status: r.status as "running" | "waiting",
                  botId: r.botId,
                  name: routine?.name ?? r.trialDraft?.name ?? "Routine",
                  conversationId: r.conversationId,
                },
              ]
            : [];
        });
      await abortable(
        namespace.updateTray(
          { next, counts, running, pausedUntil: s.settings.pausedUntil() },
          signal,
        ),
        signal,
      );
      this.emit(new Date(now).toISOString());
      this.refreshedAt = performance.now();
    } catch (error) {
      this.keepAwake = "unsupported";
      this.refreshedAt = performance.now();
      if (epochEnded(error)) s.deps.logger.info("Routine host epoch ended; refresh skipped");
      else s.deps.logger.warn(`Routine host unavailable reason=${failureLabel(error)}`);
    }
  }
  unsubscribe() {
    for (const off of this.unsubscriptions.splice(0)) off();
  }
  async stop() {
    this.unsubscribe();
    const namespace = this.service.deps.routineHost;
    if (!namespace) return;
    const signal = AbortSignal.timeout(5000);
    try {
      await abortable(
        namespace.keepAwake(
          { mode: "never", reason: "none", leaseId: this.leaseId, leaseMs: 1000 },
          signal,
        ),
        signal,
      );
    } catch (error) {
      // On quit the host ends this brain's epoch before asking it to stop, so the release is
      // normally refused as stale. The lease cannot outlive the brain either way: the host drops
      // it on epoch end and on process exit, and it expires after leaseMs. A refused release is
      // therefore not a drain failure and must not keep the database from closing.
      if (!epochEnded(error))
        this.service.deps.logger.warn(
          `Routine keep-awake release unavailable reason=${failureLabel(error)}`,
        );
    }
  }
}
