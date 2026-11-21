import { randomUUID } from "node:crypto";
import type { ComputerRunContext } from "@pibot/brain/kit";
import { resolvePersonaLanguage } from "@pibot/brain/kit";
import {
  type ComputerApp,
  type ComputerGuardAction,
  type ComputerGuardEntry,
  type ComputerState,
  RpcError,
  sameAppId,
} from "@pibot/computer-use-contract/full";
import { AppBlocklistRepo, BotsRepo, SettingsRepo } from "@pibot/storage";

import type { ComputerContext } from "../../context.ts";
import { delay, ForegroundLock } from "../grants/computer-foreground.ts";
import { evaluateComputerCall } from "../grants/computer-grants-checks.ts";
import { coversApps, type RunGrant } from "../grants/computer-grants-issue.ts";
import { ComputerGuardSync } from "../grants/computer-guard-sync.ts";

// A foreground step may last one driver call (15 s budget) before another Bot gets its turn.
const FOREGROUND_LEASE_MS = 20_000;
const IDLE_SECONDS = 3;
const ACTIVITY_POLL_MS = 250;

/** In-memory view of one run that has asked to operate the computer. */
export interface ComputerRun {
  botId: string;
  runId: string;
  context: ComputerRunContext;
  grant?: RunGrant;
  hadGrant: boolean;
  closed: boolean;
  paused: boolean;
  pausedBy: "activity" | "locked" | null;
  app: ComputerApp | null;
  step: string | null;
  stepCount: number;
  foreground: ComputerForeground | null;
  confirm?: {
    requestId: string;
    action: string;
    settle(allow: boolean, actor?: "user" | "automatic"): void;
  };
  resume: Set<() => void>;
  userActive: boolean;
  screenLocked: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  lastState?: string;
}

type ComputerForeground = NonNullable<ComputerState["foreground"]>;

const clean = (value: string, max: number, fallback: string) =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, max) || fallback;

/**
 * Runtime protections: user pause, stop (button, shortcut, RPC), the foreground
 * lock with "Allow / Skip" and the idle / unlocked wait, the indicator mirror and the
 * `computer.state` events. Grants themselves are issued by `ComputerGrantService`.
 */
export class ComputerRuns {
  readonly map = new Map<string, ComputerRun>();
  readonly lock = new ForegroundLock(FOREGROUND_LEASE_MS, () => this.changedAll());
  readonly guard: ComputerGuardSync;

  constructor(
    private readonly local: ComputerContext,
    private readonly stopRun: (runId: string, actor: "user" | "shortcut") => Promise<void>,
  ) {
    this.guard = new ComputerGuardSync({
      host: () => local.deps.host.computerGuard,
      // The indicator is app chrome: it follows the interface language setting, not the
      // language the user happened to write this run's message in.
      snapshot: () => ({ language: this.language(), entries: this.entries() }),
      onAction: (action) => this.onAction(action),
      logger: local.deps.logger,
      shutdown: local.shutdown.signal,
    });
  }

  private language() {
    return resolvePersonaLanguage(
      new SettingsRepo(this.local.deps.db).get().language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    );
  }

  ensure(context: ComputerRunContext): ComputerRun {
    let run = this.map.get(context.runId);
    if (!run) {
      run = {
        botId: context.botId,
        runId: context.runId,
        context,
        hadGrant: false,
        closed: false,
        paused: false,
        pausedBy: null,
        app: null,
        step: null,
        stepCount: 0,
        foreground: null,
        resume: new Set(),
        userActive: false,
        screenLocked: false,
      };
      this.map.set(context.runId, run);
    }
    run.context = context;
    return run;
  }

  valid(run: ComputerRun | undefined): RunGrant | undefined {
    return run && !run.closed && run.grant && run.grant.expiresAt > Date.now()
      ? run.grant
      : undefined;
  }

  ofBot(botId: string): ComputerRun[] {
    return [...this.map.values()].filter((run) => run.botId === botId);
  }

  /** Waits while the user has paused this Bot from the indicator or the app. */
  async whilePaused(run: ComputerRun, signal: AbortSignal): Promise<void> {
    if (run.paused) run.context.executionClock?.pause("computer_paused");
    try {
      while (run.paused && !run.closed) {
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            signal.removeEventListener("abort", abort);
            run.resume.delete(done);
            resolve();
          };
          const abort = () => {
            run.resume.delete(done);
            reject(signal.reason);
          };
          signal.throwIfAborted();
          signal.addEventListener("abort", abort, { once: true });
          run.resume.add(done);
        });
      }
    } finally {
      run.context.executionClock?.resume("computer_paused");
    }
  }

  pause(botId: string, paused: boolean): void {
    for (const run of this.ofBot(botId)) {
      if (!this.valid(run)) continue;
      run.paused = paused;
      if (!paused) for (const resume of [...run.resume]) resume();
      this.changed(run);
    }
  }

  /**
   * Foreground step: queue for the lock, ask when the grant says so (unless this run
   * already holds the lock from the previous step), then wait until the screen is unlocked and
   * the user has been idle for 3 seconds. Returns "skip" whenever any of that cannot happen.
   */
  async foreground(
    context: ComputerRunContext,
    step: { app: string; description: string },
    signal: AbortSignal,
  ): Promise<"allow" | "skip"> {
    if (context.runWorkplace?.boundary.location?.target.startsWith("runner:")) return "skip";
    const run = this.map.get(context.runId);
    const grant = this.valid(run);
    const host = this.local.computerHost(context);
    if (!run || !grant || !host || !coversApps(grant, [step.app])) return "skip";
    const action = clean(step.description, 200, "foreground step");
    const app = grant.apps.find((held) => sameAppId(held.id, step.app)) ?? {
      id: step.app,
      name: step.app,
    };
    await this.whilePaused(run, signal);
    const held = this.lock.holds(run.runId);
    const request: ComputerForeground = {
      requestId: randomUUID(),
      app,
      action,
      status: "queued",
    };
    run.foreground = request;
    run.step = action;
    this.changed(run);
    try {
      await this.lock.acquire(run.runId, signal);
      // Confirmation/idle waits can outlast the between-step lease without certifying drain.
      this.lock.pin(run.runId);
      if (grant.row.foregroundAsk && !held) {
        if (this.local.isYolo(context)) {
          if (!(await this.allowForegroundYolo(run, signal))) {
            this.lock.release(run.runId);
            return "skip";
          }
          this.auditForegroundYolo(run);
        } else {
          request.status = "asking";
          if (!(await this.confirm(run, request.requestId, action, signal))) {
            this.lock.release(run.runId);
            return "skip";
          }
        }
      }
      if (!(await this.waitForUser(run, grant, request, signal))) {
        this.lock.release(run.runId);
        return "skip";
      }
      request.status = "running";
      run.app = app;
      run.stepCount++;
      this.changed(run);
      return "allow";
    } catch (error) {
      this.lock.release(run.runId);
      if (signal.aborted) throw error;
      this.local.deps.logger.warn(`computer foreground wait failed run=${run.runId}`);
      return "skip";
    }
  }

  foregroundResolve(requestId: string, allow: boolean): void {
    const run = [...this.map.values()].find((item) => item.confirm?.requestId === requestId);
    if (!run?.confirm) throw new RpcError(-32602, "computer_foreground_unavailable");
    run.confirm.settle(allow);
  }

  /** A mode switch releases only this conversation's application confirmation, never OS consent. */
  async releaseForYolo(): Promise<void> {
    for (const run of this.map.values()) {
      if (!run.confirm || !this.local.isYolo(run.context)) continue;
      const request = run.confirm;
      const allowed = await this.allowForegroundYolo(run, run.context.signal);
      if (run.confirm === request && this.local.isYolo(run.context))
        request.settle(allowed, "automatic");
    }
  }

  private async allowForegroundYolo(run: ComputerRun, signal: AbortSignal): Promise<boolean> {
    const app = run.foreground?.app.id;
    const grant = this.valid(run);
    if (!app || !grant || !coversApps(grant, [app])) return false;
    const result = await evaluateComputerCall(
      this.local,
      run.context,
      { tool: "foreground", apps: [app], coordinates: false, always: [] },
      signal,
    );
    return (
      !run.closed &&
      this.valid(run) === grant &&
      this.local.isYolo(run.context) &&
      result.decision !== "deny" &&
      !new AppBlocklistRepo(this.local.deps.db).blockedAmong([app]).size
    );
  }

  private auditForegroundYolo(run: ComputerRun) {
    this.local.approvals.audit.append({
      botId: run.botId,
      runId: run.runId,
      kind: "approval.resolved",
      summary: "Foreground step allowed by YOLO / YOLO 自动允许前台步骤",
      detail: {
        category: "computer",
        decision: "allow",
        actor: "automatic",
        reasonCode: "yolo",
        source: run.context.routineSource ?? "chat",
      },
    });
  }

  private waitBudget(run: ComputerRun) {
    return run.context.routineRunId ? (run.context.routineApprovalWaitMs ?? 86_400_000) : 600_000;
  }

  private confirm(
    run: ComputerRun,
    requestId: string,
    action: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    run.context.executionClock?.pause("computer_foreground");
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        run.context.executionClock?.resume("computer_foreground");
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        run.confirm = undefined;
        this.changed(run);
      };
      const settle = (allow: boolean, actor: "user" | "automatic" = "user") => {
        cleanup();
        this.local.approvals.audit.append({
          botId: run.botId,
          runId: run.runId,
          kind: "approval.resolved",
          summary: `Foreground step ${allow ? "allowed" : "skipped"} / 前台步骤${allow ? "已允许" : "已跳过"}`,
          detail: {
            category: "computer",
            decision: allow ? "allow" : "deny",
            actor,
            reasonCode:
              actor === "automatic" && allow && this.local.isYolo(run.context)
                ? "yolo"
                : "computer_foreground",
            source: run.context.routineSource ?? "chat",
          },
        });
        resolve(allow);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      // Unanswered like an approval card: 10 minutes in chat, the routine's wait otherwise.
      const timer = setTimeout(() => settle(false, "automatic"), this.waitBudget(run));
      signal.addEventListener("abort", abort, { once: true });
      run.confirm = { requestId, action, settle };
      this.changed(run);
    });
  }

  private async waitForUser(
    run: ComputerRun,
    grant: RunGrant,
    request: ComputerForeground,
    signal: AbortSignal,
  ): Promise<boolean> {
    run.context.executionClock?.pause("computer_user_activity");
    try {
      const host = this.local.computerHost(run.context);
      const deadline = Date.now() + this.waitBudget(run);
      while (host && !run.closed && this.valid(run) === grant && Date.now() < deadline) {
        await this.whilePaused(run, signal);
        const activity = await host.call(
          "host.computer.userActivity",
          { token: grant.token },
          AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        );
        if (!activity.ok) return false;
        run.screenLocked = activity.locked;
        run.userActive = activity.idleSeconds < IDLE_SECONDS;
        // Injected input into a locked screen lands in the login window's password field.
        run.pausedBy = activity.locked ? "locked" : run.userActive ? "activity" : null;
        request.status = activity.locked
          ? "waiting_unlock"
          : run.userActive
            ? "waiting_idle"
            : request.status;
        this.changed(run);
        if (!run.pausedBy) return true;
        await delay(ACTIVITY_POLL_MS, signal);
      }
      return false;
    } finally {
      run.context.executionClock?.resume("computer_user_activity");
    }
  }

  private onAction(action: ComputerGuardAction) {
    if (action.kind === "foreground") {
      try {
        this.foregroundResolve(action.requestId, action.allow);
      } catch {
        // The step was already answered, skipped or stopped; a late click has nothing to do.
      }
      return;
    }
    const botIds =
      action.kind === "stopAll"
        ? [...new Set([...this.map.values()].map((run) => run.botId))]
        : [action.botId];
    for (const botId of botIds) {
      if (action.kind === "pause" || action.kind === "resume")
        this.pause(botId, action.kind === "pause");
      else
        for (const run of this.ofBot(botId))
          void this.stopRun(run.runId, action.kind === "stopAll" ? "shortcut" : "user").catch(() =>
            this.local.deps.logger.warn(`computer stop failed run=${run.runId}`),
          );
    }
  }

  state(run: ComputerRun, final = false): ComputerState {
    const grant = final ? undefined : this.valid(run);
    const foreground =
      run.foreground && (run.foreground.status !== "running" || this.lock.holds(run.runId))
        ? {
            ...run.foreground,
            ...(run.foreground.status === "queued" && this.lock.position(run.runId)
              ? { queuePosition: this.lock.position(run.runId) }
              : {}),
          }
        : null;
    return {
      botId: run.botId,
      runId: run.runId,
      state: final
        ? "stopped"
        : !grant
          ? "idle"
          : run.paused || run.pausedBy
            ? "paused"
            : this.lock.holds(run.runId)
              ? "foreground"
              : "background",
      app: run.app,
      pausedBy: run.paused ? "user" : run.pausedBy,
      foreground: final ? null : foreground,
      userActive: run.userActive,
      screenLocked: run.screenLocked,
      stepCount: run.stepCount,
      grant: grant?.row ?? null,
    };
  }

  /** Emits `computer.state` when the run's view changed and refreshes the indicator. */
  changed(run: ComputerRun, final = false): void {
    const state = this.state(run, final);
    const key = JSON.stringify(state);
    if (key !== run.lastState) {
      run.lastState = key;
      this.local.deps.peer.emit("computer.state", state);
    }
    this.guard.changed();
  }

  private changedAll() {
    for (const run of this.map.values()) this.changed(run);
    this.guard.changed();
  }

  private entries(): ComputerGuardEntry[] {
    const bots = new BotsRepo(this.local.deps.db);
    return [...this.map.values()]
      .filter(
        (run) =>
          this.valid(run) &&
          !run.context.runWorkplace?.boundary.location?.target.startsWith("runner:"),
      )
      .slice(0, 20)
      .map((run) => {
        const grant = this.valid(run) as RunGrant;
        const waiting = !!run.foreground && run.foreground.status !== "running" && !run.confirm;
        return {
          botId: run.botId,
          runId: run.runId,
          botName: clean(bots.get(run.botId)?.name ?? "", 80, "Bot"),
          ...colorOf(bots.get(run.botId)?.avatarColor),
          apps: grant.apps.map((app) => clean(app.name, 200, app.id)),
          mode:
            run.paused || run.pausedBy
              ? "paused"
              : waiting
                ? "waiting"
                : this.lock.holds(run.runId)
                  ? "foreground"
                  : "background",
          pausedBy: run.paused ? "user" : run.pausedBy,
          step: run.step,
          confirm: run.confirm
            ? { requestId: run.confirm.requestId, action: run.confirm.action }
            : null,
        };
      });
  }

  /** Revoke local authority immediately, retaining the physical lock until certified drain. */
  close(run: ComputerRun): void {
    if (run.closed) return;
    run.closed = true;
    clearTimeout(run.expiry);
    this.lock.pin(run.runId);
    run.confirm?.settle(false, "automatic");
    for (const resume of [...run.resume]) resume();
    this.changed(run, true);
  }

  drained(runId: string): void {
    const run = this.map.get(runId);
    if (!run?.closed) return;
    this.map.delete(runId);
    this.lock.release(runId);
    this.changed(run, true);
  }

  dispose(): void {
    this.guard.dispose();
    this.lock.dispose();
    for (const run of this.map.values()) clearTimeout(run.expiry);
  }
}

/** The indicator's dot matches the Bot's avatar colour (a plain colour name only). */
function colorOf(color: string | undefined) {
  return color && /^[a-z]{1,20}$/.test(color) ? { botColor: color } : {};
}
