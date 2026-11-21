import type { LocalToolCall } from "@pibot/agent";
import type { ComputerRunContext } from "@pibot/brain/kit";
import {
  abortable,
  allowedByYolo,
  blockedReason,
  computerTarget,
  isComputerTool,
} from "@pibot/brain/kit";
import {
  type Approval,
  type ComputerApp,
  type ComputerApprovalRequest,
  type ComputerGrant,
  type ComputerGrantResolve,
  ComputerGrantResolveSchema,
  RpcError,
  sameAppId,
} from "@pibot/computer-use-contract/full";
import type { PolicyResult } from "@pibot/policy";
import { explainPolicyResult } from "@pibot/policy";
import {
  AppBlocklistRepo,
  ApprovalPausesRepo,
  ApprovalsRepo,
  BotComputerAlwaysRepo,
  ComputerGrantsRepo,
} from "@pibot/storage";
import type { ComputerContext } from "../../context.ts";
import { type ComputerRun, ComputerRuns } from "../run/computer-runs.ts";
import {
  cardPayload,
  cardStillAllowed,
  cardTitle,
  chooseOnCard,
  commitCard,
  newCard,
  type PendingCard,
} from "./computer-grants-card.ts";
import {
  computerPreauthorized,
  evaluateComputerCall,
  resolveComputerApps,
} from "./computer-grants-checks.ts";
import {
  coversApps,
  createGrantRow,
  newGrantToken,
  type RunGrant,
  registerGrant,
  unionApps,
} from "./computer-grants-issue.ts";

/** The operating-the-computer gate used by `LocalRun.authorize` and the computer tools' execution. */
export interface ComputerGrantGate {
  // LocalRun.authorize calls this for computer tools: a valid covering grant passes; otherwise the
  // call waits on a grant card (chat 10 min / routine 24 h); "allow" issues a token and
  // registers it with the host.
  authorize(
    context: ComputerRunContext,
    call: { id: string; tool: string; input: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ComputerDecision>;
  // The run's token for the tools' host calls (memory only, never stored or logged).
  token(runId: string): string | undefined;
  // Before a foreground step: foreground lock, "Allow / Skip" when asked for, idle / unlocked.
  foreground(
    context: ComputerRunContext,
    step: { app: string; description: string },
    signal: AbortSignal,
  ): Promise<"allow" | "skip">;
  // Run end / stop: revokes the run's grant (host registry and `revoked_at`).
  release(runId: string): Promise<void>;
}

/** `yolo`: the call passed because its conversation has YOLO on, with that risk. */
export type ComputerDecision = { allow: boolean; reason?: string; yolo?: "normal" | "danger" };
const deny = (reason: string): ComputerDecision => ({ allow: false, reason });
const UNAVAILABLE =
  "这台电脑上不能操作电脑 / Operating the computer is not available on this computer";
const onRunner = (context: ComputerRunContext) =>
  !!context.runWorkplace?.boundary.location?.target.startsWith("runner:");
const RUNNER_UNAVAILABLE =
  "这个执行端不支持操作电脑，或需要升级执行端 / This runner does not support computer control, or the runner needs to be upgraded";
const IDENTITY_UNAVAILABLE =
  "未能确认已安装应用的身份，尚未生成审批；请使用应用列表中的名称或 ID，不是用户拒绝或审批通道不可用 / No approval was created because the installed app identity could not be verified. Use a name or ID from the app list; this is not a user refusal or an unavailable approval channel";
const BLOCKED =
  "该应用在不能操作的应用名单里，请换办法 / This app is on the do-not-operate list; use another approach";
const INSTALLED_TTL_MS = 5 * 60_000;
/**
 * The overlay's / indicator's 停止 takes computer control away; the task itself goes on (owner
 * 2026-11-14), so the model is told what happened and what it can still do.
 */
export const STOPPED_BY_USER =
  "用户停止了操作电脑，这次任务的操作授权已撤销；这次任务里不要再调用电脑工具。继续用其他工具完成（网页用 Bot 内置浏览器 browser_open），做不到的部分告诉用户需要他做什么 / The user stopped computer control and this run's grant is revoked; do not call computer tools again in this task. Continue with other tools (web pages in the Bot's built-in browser, browser_open), and tell the user what you need from them for anything left";
const WHOLE_DISPLAY =
  "整屏截图需要先授权具体应用：请先用 app 指定应用 / A whole-display screenshot needs an app grant first; name an app in `app`";
const NOT_COVERED: Record<"apps" | "coordinates", string> = {
  apps: "用户没有允许操作这个应用，请换办法 / The user did not allow this app; use another approach",
  coordinates:
    "用户没有允许截图点击，请改用界面树操作 / The user did not allow screenshot clicks; use the UI tree instead",
};

/**
 * Issues and tracks operation grants: one grant and token per run,
 * extended without a card when the Bot's always-list or a routine preauthorization covers the
 * new apps, otherwise through the grant card. The blocklist is checked again before every pass.
 */
export class ComputerGrantService implements ComputerGrantGate {
  private readonly closing = new Map<string, Promise<void>>();
  private readonly grantQueue = new WeakMap<ComputerRun, Promise<void>>();
  private readonly expiring = new WeakMap<ComputerRun, Promise<void>>();
  /** Cancels a run like `chat.abort` (wired by brain's entry, which owns the chat service). */
  abortRun?: (runId: string) => Promise<void>;
  /** Display name of the model vendor that receives screenshots; null for a local model. */
  providerName: (botId: string) => string | null = () => null;
  readonly runs: ComputerRuns;
  private readonly cards = new Map<string, PendingCard>();
  private installed?: { at: number; apps: Promise<ComputerApp[]> };
  private blocklistMirrored = false;
  private blocklistSync: Promise<void> = Promise.resolve();
  /** Runs whose computer control the user stopped; they keep running without it until drained. */
  private readonly stoppedRuns = new Set<string>();

  constructor(private readonly local: ComputerContext) {
    this.runs = new ComputerRuns(local, (runId, actor) => this.stopRun(runId, actor));
  }

  isIdle(): boolean {
    return this.runs.map.size === 0 && this.cards.size === 0;
  }

  /** The user took computer control away from this run (stop button, indicator, shortcut). */
  stoppedByUser(runId: string): boolean {
    return this.stoppedRuns.has(runId);
  }

  token(runId: string): string | undefined {
    return this.runs.valid(this.runs.map.get(runId))?.token;
  }

  /** The run's granted apps with the names the user saw on the card. */
  grantedApps(runId: string): readonly ComputerApp[] {
    return this.runs.valid(this.runs.map.get(runId))?.apps ?? [];
  }

  foreground(
    context: ComputerRunContext,
    step: { app: string; description: string },
    signal: AbortSignal,
  ): Promise<"allow" | "skip"> {
    const run = this.runs.map.get(context.runId);
    const grant = this.runs.valid(run);
    // A blocklist edit after the grant wins over it.
    if (!grant || this.blocked([step.app])) return Promise.resolve("skip");
    return this.runs.foreground(context, step, signal);
  }

  authorize(
    context: ComputerRunContext,
    call: { id: string; tool: string; input: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ComputerDecision> {
    const stopped = () => this.stoppedRuns.has(context.runId);
    if (stopped()) return Promise.resolve(deny(STOPPED_BY_USER));
    const run = this.runs.ensure(context);
    return abortable(
      this.serialGrant(run, async () => {
        signal.throwIfAborted();
        await this.waitForExpiry(run);
        signal.throwIfAborted();
        return this.authorizeNow(context, call, signal, run);
      }),
      signal,
    ).then(
      // A stop while this call waited (card, pause, install) answers it the same way.
      (decision) => (stopped() ? deny(STOPPED_BY_USER) : decision),
      (error) => {
        if (stopped() && !signal.aborted) return deny(STOPPED_BY_USER);
        throw error;
      },
    );
  }

  private async authorizeNow(
    context: ComputerRunContext,
    call: { id: string; tool: string; input: Record<string, unknown> },
    signal: AbortSignal,
    run: ComputerRun,
  ): Promise<ComputerDecision> {
    if (!isComputerTool(call.tool)) return deny(blockedReason("category_unavailable"));
    const host = this.local.computerHost(context);
    if (!host) return deny(onRunner(context) ? RUNNER_UNAVAILABLE : UNAVAILABLE);
    const target = computerTarget(call.tool, call.input);
    if (!target.ok) return deny(target.reason);
    await this.runs.whilePaused(run, signal);
    let apps: ComputerApp[];
    try {
      apps = await this.resolveApps(context, target.apps, target.byName, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof RpcError &&
        error.code === -32602 &&
        error.message === "computer_app_identity_unavailable"
      ) {
        this.local.deps.logger.warn(
          JSON.stringify({
            module: "computer-grants",
            event: "app_identity_unavailable",
            reasonCode: "computer_app_identity_unavailable",
            botId: context.botId,
            runId: context.runId,
            tool: call.tool,
          }),
        );
        return deny(IDENTITY_UNAVAILABLE);
      }
      throw error;
    }
    signal.throwIfAborted();
    const ids = apps.map((app) => app.id);
    if (this.blocked(ids)) return deny(BLOCKED);
    const groupId = this.local.permissionScope(context);
    context.permissionGroupId = groupId;
    const restriction = this.local.connectionRestriction(context, call.tool, ids);
    if (restriction) return deny(restriction);
    const always = groupId
      ? [
          ...new Set(
            this.local
              .grants(context.botId, context)
              .flatMap((grant) =>
                grant.category === "computer" && grant.scope.kind === "apps"
                  ? grant.scope.apps
                  : [],
              ),
          ),
        ].map((id) => ({ id, name: id }))
      : (new BotComputerAlwaysRepo(this.local.deps.db).get(context.botId)?.apps ?? []);
    const result = await evaluateComputerCall(
      this.local,
      context,
      { tool: call.tool, apps: ids, coordinates: target.coordinates, always },
      signal,
    );
    if (result.decision === "deny") return deny(blockedReason(result.reason));
    const latestRestriction = this.local.connectionRestriction(context, call.tool, ids);
    if (latestRestriction) return deny(latestRestriction);
    if (run.closed) return deny(blockedReason("changed"));
    const current = this.runs.valid(run);
    if (
      current &&
      coversApps(current, ids) &&
      (!target.coordinates || current.row.allowCoordinates)
    )
      return {
        ...this.pass(run, apps),
        ...(allowedByYolo(result) ? { yolo: result.risk } : {}),
      };
    const wholeDisplay = !ids.length && !current;
    if (allowedByYolo(result)) {
      // YOLO answers the card the way "allow" would, never the always-list; the grant
      // still ends with the run and the indicator, foreground lock and stop shortcut stay.
      if (wholeDisplay) return deny(WHOLE_DISPLAY);
      await this.extend(run, apps, "yolo", signal, target.coordinates);
      return { ...this.pass(run, apps), yolo: result.risk };
    }
    if (
      result.decision === "allow" ||
      computerPreauthorized(this.local, context, ids, target.coordinates)
    ) {
      await this.extend(
        run,
        apps,
        result.decision === "allow" ? "computer_always_list" : "routine_preauth",
        signal,
      );
      return this.pass(run, apps);
    }
    if (wholeDisplay) return deny(WHOLE_DISPLAY);
    return this.ask(run, call, apps, target.coordinates, always, result, signal);
  }

  private async resolveApps(
    context: ComputerRunContext,
    raw: string[],
    byName: boolean,
    signal: AbortSignal,
  ) {
    const host = this.local.computerHost(context);
    if (!host)
      throw new RpcError(
        -32602,
        onRunner(context) ? "runner_computer_unavailable" : "computer_host_unavailable",
      );
    return resolveComputerApps(
      raw,
      byName,
      [...this.grantedApps(context.runId)],
      () => this.installedApps(AbortSignal.any([signal, AbortSignal.timeout(15_000)]), context),
      async (name) => {
        const result = await host.call(
          "host.computer.resolveAppName",
          { name },
          AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        );
        signal.throwIfAborted();
        return result.id ?? undefined;
      },
      true,
    );
  }

  /** Resolve identity only; the caller rechecks current connection state synchronously before sending. */
  async dispatchApp(context: ComputerRunContext, tool: string, raw: string, signal: AbortSignal) {
    const [app] = await this.resolveApps(context, [raw], tool === "open_app", signal);
    signal.throwIfAborted();
    if (!app) throw new RpcError(-32602, "computer_app_identity_unavailable");
    return { app: app.id };
  }

  release(runId: string): Promise<void> {
    const existing = this.closing.get(runId);
    if (existing) return existing;
    const run = this.runs.map.get(runId);
    if (!run) return Promise.resolve();
    const finished = this.revoke(run);
    this.closing.set(runId, finished);
    return finished;
  }

  /** Only the owner that certified SDK drain may release the foreground lock. */
  drained(runId: string): void {
    this.stoppedRuns.delete(runId);
    this.runs.drained(runId);
    this.local.releaseComputerHost(runId);
    this.closing.delete(runId);
  }

  private async revoke(run: ComputerRun): Promise<void> {
    const runId = run.runId;
    this.runs.close(run);
    if (!run.hadGrant) return;
    const revoked = new ComputerGrantsRepo(this.local.deps.db).revokeRun(runId);
    if (revoked)
      this.local.approvals.audit.append({
        botId: run.botId,
        runId,
        kind: "grant.revoked",
        summary: "Computer operation grant ended / 操作电脑的授权已结束",
        detail: { category: "computer", actor: "system", reasonCode: "run_finished" },
      });
    try {
      const host = this.local.computerHost(run.context);
      if (!host) throw new Error("computer_cleanup_failed");
      await host.call("host.computer.grants.revoke", { runId }, AbortSignal.timeout(5000));
    } catch {
      this.local.deps.logger.warn(`computer grant revoke unavailable run=${runId}`);
      throw new RpcError(-32603, "computer_cleanup_failed");
    }
  }

  /**
   * A card waiting when its conversation turns YOLO on is answered like "allow" with the
   * suggested apps for this task, screenshot clicks only if asked for, and no foreground asks.
   */
  async resolveForYolo(approval: Approval) {
    const request = approval.computer;
    const apps = request?.apps.filter((app) => app.suggested && !app.blocked).map((app) => app.id);
    if (!request || !apps?.length) throw new RpcError(-32602, "computer_app_blocked");
    return this.resolve(
      {
        approvalId: approval.id,
        decision: "allow",
        apps,
        duration: "task",
        foregroundAsk: true,
        allowCoordinates: request.coordinatesRequested,
      },
      "yolo",
    );
  }

  /** `computer.grant.resolve`: the card's choice, then the shared approval resolution. */
  async resolve(
    params: ComputerGrantResolve,
    by: "user" | "yolo" = "user",
  ): Promise<{ ok: true; grant: ComputerGrant | null }> {
    this.local.approvals.pauseExpiredChat(params.approvalId);
    const card = this.cards.get(params.approvalId);
    const pauses = new ApprovalPausesRepo(this.local.deps.db);
    if (!card || pauses.get(params.approvalId)) {
      const stored = new ApprovalsRepo(this.local.deps.db).get(params.approvalId);
      if (!pauses.get(params.approvalId) || !stored?.computer || stored.status !== "pending")
        throw new RpcError(-32602, "Approval is no longer pending");
      if (by !== "user")
        throw new RpcError(-32602, "Paused approval requires a one-time user decision");
      if (params.decision === "allow") {
        if (
          params.always ||
          params.apps.some(
            (id) => !stored.computer?.apps.some((app) => sameAppId(app.id, id) && !app.blocked),
          )
        )
          throw new RpcError(-32602, "Paused computer approval requires the offered apps");
        pauses.choice(params.approvalId, params);
      }
      try {
        await this.local.approvals.resolve(params.approvalId, params.decision, false, false, by);
      } catch (error) {
        if (params.decision === "allow") pauses.clearChoice(params.approvalId, params);
        throw error;
      }
      return { ok: true, grant: null };
    }
    if (params.decision === "deny") {
      await this.local.approvals.resolve(params.approvalId, "deny", false, false, by);
      return { ok: true, grant: null };
    }
    const installed = await this.installedApps(AbortSignal.timeout(15_000));
    this.local.approvals.pauseExpiredChat(params.approvalId);
    if (pauses.get(params.approvalId)) return this.resolve(params, by);
    card.chosen = chooseOnCard(
      this.local,
      card,
      params,
      (id) => installed.find((app) => sameAppId(app.id, id))?.name ?? id,
    );
    card.yolo = by === "yolo";
    try {
      await this.local.approvals.resolve(params.approvalId, "allow", false, false, by);
    } catch (error) {
      card.chosen = undefined;
      card.yolo = false;
      if (
        pauses.get(params.approvalId) &&
        new ApprovalsRepo(this.local.deps.db).get(params.approvalId)?.status === "pending"
      )
        return this.resolve(params, by);
      throw error;
    }
    return { ok: true, grant: card.row ?? null };
  }

  /** Stops the Bot's runs that operate the computer (`computer.stop`, indicator, shortcut). */
  async stop(botId: string): Promise<void> {
    await Promise.all(this.runs.ofBot(botId).map((run) => this.stopRun(run.runId, "user")));
  }

  /** Installed apps from the host, cached briefly; empty where unsupported. */
  installedApps(signal: AbortSignal, context?: ComputerRunContext): Promise<ComputerApp[]> {
    const host = context ? this.local.computerHost(context) : this.local.deps.host.computer;
    if (!host) return Promise.resolve([]);
    if (!context && this.installed && Date.now() - this.installed.at < INSTALLED_TTL_MS)
      return this.installed.apps;
    const apps = host.call("host.computer.installedApps", {}, signal).then(
      (result) => (result.supported ? result.apps.map(({ id, name }) => ({ id, name })) : []),
      () => {
        this.installed = undefined;
        return [];
      },
    );
    if (!context) this.installed = { at: Date.now(), apps };
    return apps;
  }

  /** Mirrors the blocklist into the host's driver check (defence in depth). */
  mirrorBlocklist(): Promise<void> {
    const next = this.blocklistSync.then(() => this.syncBlocklist());
    this.blocklistSync = next.catch(() => {
      /* The requesting RPC observes failure; later syncs may repair it. */
    });
    return next;
  }

  private async syncBlocklist(): Promise<void> {
    const guard = this.local.deps.host.computerGuard;
    if (!guard) {
      this.blocklistMirrored = false;
      this.local.deps.logger.warn("computer blocklist mirror unavailable");
      throw new RpcError(-32603, "computer_blocklist_unavailable");
    }
    try {
      const appIds = new AppBlocklistRepo(this.local.deps.db).list().map((entry) => entry.appId);
      await guard.call("host.computerGuard.blocklist", { appIds }, AbortSignal.timeout(5000));
      this.blocklistMirrored = true;
    } catch {
      this.blocklistMirrored = false;
      this.local.deps.logger.warn("computer blocklist mirror unavailable");
      // '*' is a deny-all mirror, never an app grant. If transport is down, revoke every
      // existing token as well; no new grant may be installed until a later sync succeeds.
      const sealed = await Promise.allSettled([
        guard.call("host.computerGuard.blocklist", { appIds: ["*"] }, AbortSignal.timeout(5000)),
        ...[...this.runs.map.values()].map((run) => this.release(run.runId)),
      ]);
      if (sealed.some((result) => result.status === "rejected"))
        this.local.deps.logger.warn("computer blocklist fail-closed drain unconfirmed");
      throw new RpcError(-32603, "computer_blocklist_unavailable");
    }
  }

  dispose(): void {
    this.runs.dispose();
  }

  private blocked(ids: readonly string[]): boolean {
    return ids.length > 0 && new AppBlocklistRepo(this.local.deps.db).blockedAmong(ids).size > 0;
  }

  private pass(run: ComputerRun, apps: ComputerApp[]) {
    if (apps[0]) run.app = apps[0];
    run.stepCount++;
    this.runs.changed(run);
    return { allow: true };
  }

  /**
   * Revokes the run's computer control and lets the run continue: its next computer call, and
   * one still in flight, get STOPPED_BY_USER as their result. Ending the task is the composer's
   * stop button (chat.abort). Only when the host cannot confirm the revoke is the run aborted,
   * because native input may still be running.
   */
  private async stopRun(runId: string, actor: "user" | "shortcut"): Promise<void> {
    const run = this.runs.map.get(runId);
    if (!run || this.stoppedRuns.has(runId)) return;
    this.stoppedRuns.add(runId);
    this.local.approvals.audit.append({
      botId: run.botId,
      runId,
      kind: "grant.revoked",
      summary: "Computer operation stopped by the user / 用户停止了操作电脑",
      detail: {
        category: "computer",
        actor: "user",
        reasonCode: actor === "shortcut" ? "computer_stop_shortcut" : "computer_stop",
      },
    });
    // A card still asking for more apps, or to come and help, would otherwise hold the run for
    // its whole wait.
    this.local.computerHandoff.cancelRun(runId);
    for (const [approvalId, card] of this.cards)
      if (card.context.runId === runId)
        await this.local.approvals.resolve(approvalId, "deny", false, false, "user").catch(() => {
          // Already answered or expired: the waiting call settles on its own.
        });
    try {
      await this.release(runId);
    } catch (error) {
      await this.abortRun?.(runId);
      throw error;
    }
    // The host revoked the token and drained its driver calls, so no native input remains; other
    // Bots need not wait for this run's end to get the foreground.
    this.runs.lock.release(runId);
  }

  /** Extends (or creates) the run's grant without a card: always-list, routine preauth or YOLO. */
  private async extend(
    run: ComputerRun,
    apps: ComputerApp[],
    reasonCode: string,
    signal: AbortSignal,
    /** YOLO only: the call needs screenshot clicks, which the always-list never covers. */
    coordinates = false,
  ): Promise<void> {
    const current = this.runs.valid(run);
    const { token, hash } = newGrantToken();
    const row = createGrantRow(this.local.deps.db, this.local.approvals.audit, {
      context: run.context,
      options: {
        apps: unionApps(current?.apps ?? [], apps),
        duration: current?.row.duration ?? "task",
        // YOLO bypasses foreground confirmation dynamically; switching it off restores this
        // ordinary grant default rather than retaining a silent foreground exemption.
        foregroundAsk: current?.row.foregroundAsk ?? true,
        allowCoordinates: (current?.row.allowCoordinates ?? false) || coordinates,
        ...(current ? { expiresAt: current.row.expiresAt } : {}),
      },
      hash,
      approvalId: null,
      previous: current,
      actor: "system",
      reasonCode,
    });
    await this.install(run, row, token, unionApps(current?.apps ?? [], apps), signal);
  }

  private async install(
    run: ComputerRun,
    row: ComputerGrant,
    token: string,
    apps: ComputerApp[],
    signal: AbortSignal,
  ): Promise<RunGrant> {
    const host = this.local.computerHost(run.context);
    const grant: RunGrant = { row, token, apps, expiresAt: Date.parse(row.expiresAt) };
    let previous: RunGrant | undefined;
    run.hadGrant = true;
    try {
      // The previous grant can expire while policy/approval is awaiting user input.
      await this.waitForExpiry(run);
      signal.throwIfAborted();
      previous = run.grant;
      // A runner without computer control is an expected state, not an internal failure.
      if (!host)
        throw onRunner(run.context)
          ? new RpcError(-32602, "runner_computer_unavailable")
          : new RpcError(-32603, "computer_host_unavailable");
      if (
        !run.context.runWorkplace?.boundary.location?.target.startsWith("runner:") &&
        !this.blocklistMirrored
      )
        await this.mirrorBlocklist();
      await registerGrant(host, grant, signal);
    } catch (error) {
      new ComputerGrantsRepo(this.local.deps.db).revoke(row.id);
      throw error;
    }
    if (run.closed) {
      // The run ended while the host was registering: undo instead of leaking a live token.
      new ComputerGrantsRepo(this.local.deps.db).revoke(row.id);
      void host
        .call("host.computer.grants.revoke", { token }, AbortSignal.timeout(5000))
        .catch(() => this.local.deps.logger.warn("computer grant revoke unavailable"));
      throw new RpcError(-32001, "Run stopped");
    }
    run.grant = grant;
    if (previous && previous.token !== token)
      void host
        .call("host.computer.grants.revoke", { token: previous.token }, AbortSignal.timeout(5000))
        .catch(() => this.local.deps.logger.warn("computer grant revoke unavailable"));
    clearTimeout(run.expiry);
    run.expiry = setTimeout(
      () => this.expire(run, grant),
      Math.max(0, grant.expiresAt - Date.now()),
    );
    run.expiry.unref?.();
    this.runs.changed(run);
    return grant;
  }

  private serialGrant<T>(run: ComputerRun, action: () => Promise<T>): Promise<T> {
    const pending = (this.grantQueue.get(run) ?? Promise.resolve()).then(action);
    this.grantQueue.set(
      run,
      pending.then(
        () => {},
        () => {
          // Callers observe failure; expiring separately retains unconfirmed drain failures.
        },
      ),
    );
    return pending;
  }

  private async waitForExpiry(run: ComputerRun): Promise<void> {
    // Failed drain stays a barrier; clock expiry must also work before its timer is dispatched.
    await this.expiring.get(run);
    if (run.grant && run.grant.expiresAt <= Date.now()) await this.expireNow(run, run.grant);
  }

  private expire(run: ComputerRun, grant: RunGrant) {
    void this.serialGrant(run, () => this.expireNow(run, grant)).catch(() => {
      // expireNow logs failure and retains its barrier for subsequent authorization.
    });
  }

  private async expireNow(run: ComputerRun, grant: RunGrant): Promise<void> {
    if (run.grant !== grant) return;
    run.grant = undefined;
    const lease = this.runs.lock.pin(run.runId);
    const drain = (async () => {
      this.runs.changed(run);
      const host = this.local.computerHost(run.context);
      if (!host) throw new RpcError(-32603, "computer_cleanup_failed");
      await host.call(
        "host.computer.grants.revoke",
        { token: grant.token },
        AbortSignal.timeout(5000),
      );
      if (lease) this.runs.lock.release(lease);
    })().catch(() => {
      this.local.deps.logger.warn("computer grant revoke unavailable");
      throw new RpcError(-32603, "computer_cleanup_failed");
    });
    this.expiring.set(run, drain);
    await drain;
    this.expiring.delete(run);
  }

  private async ask(
    run: ComputerRun,
    call: LocalToolCall,
    apps: ComputerApp[],
    coordinates: boolean,
    always: ComputerApp[],
    result: PolicyResult,
    signal: AbortSignal,
  ): Promise<ComputerDecision> {
    const { context } = run;
    const current = this.runs.valid(run);
    const reason: ComputerApprovalRequest["reason"] =
      current &&
      coversApps(
        current,
        apps.map((app) => app.id),
      )
        ? "coordinates"
        : current
          ? "new_app"
          : run.hadGrant
            ? "expired"
            : "first";
    const { payload, offered } = cardPayload(this.local, {
      requested: apps,
      previous: current,
      always,
      coordinates,
      reason,
      providerName: this.providerName(context.botId),
      modelAcceptsImages: context.modelAcceptsImages === true,
    });
    const card = newCard(context, offered, current);
    const ids = apps.map((app) => app.id);
    let status: Awaited<ReturnType<ComputerContext["approvals"]["request"]>>;
    try {
      status = await this.local.approvals.request(
        { ...context, signal },
        call,
        explainPolicyResult(
          { ...result, decision: "ask", canRemember: false },
          "boundary",
          "computer_grant_required",
        ),
        { available: true, reason: "command_isolation_not_applicable" },
        async () =>
          cardStillAllowed(
            this.local,
            card,
            await evaluateComputerCall(
              this.local,
              context,
              { tool: call.tool, apps: ids, coordinates: coordinates, always },
              signal,
            ),
          ),
        () => commitCard(this.local, card),
        {
          requested: (approval) => {
            card.approvalId = approval.id;
            this.cards.set(approval.id, card);
          },
          resolved: () => {},
          resuming: (value) => {
            const choice = ComputerGrantResolveSchema.parse(value);
            if (choice.decision !== "allow")
              throw new RpcError(-32602, "computer_grant_resolve_required");
            card.chosen = chooseOnCard(
              this.local,
              card,
              choice,
              (id) => offered.find((app) => sameAppId(app.id, id))?.name ?? id,
            );
            card.approvalId = choice.approvalId;
          },
        },
        undefined,
        { computer: payload, title: (language) => cardTitle(this.local, context.botId, language) },
      );
    } finally {
      if (card.approvalId) this.cards.delete(card.approvalId);
    }
    if (status !== "allowed" || !card.row || !card.chosen)
      return deny(
        status === "cancelled"
          ? "已停止 / Stopped"
          : status === "expired" || status === "auto_denied"
            ? "用户未响应，请换办法，不要重复请求 / The user did not respond; use another approach rather than repeating the request"
            : "用户拒绝，请换办法，不要重复请求 / The user denied permission; use another approach rather than repeating the request",
      );
    const grant = await this.install(run, card.row, card.token, card.chosen.apps, signal);
    if (!context.runWorkplace?.boundary.location?.target.startsWith("runner:"))
      this.prepareAutomation(grant.apps.map((app) => app.id));
    if (!coversApps(grant, ids)) return deny(NOT_COVERED.apps);
    if (coordinates && !grant.row.allowCoordinates) return deny(NOT_COVERED.coordinates);
    return this.pass(run, apps);
  }

  /** Ask macOS for Automation consent now, while the user who clicked "allow" is present. */
  private prepareAutomation(apps: string[]) {
    void this.local.deps.host.computerGuard
      ?.call("host.computerGuard.prepareAutomation", { apps }, AbortSignal.timeout(10_000))
      .catch(() => this.local.deps.logger.warn("computer automation warm-up unavailable"));
  }
}
