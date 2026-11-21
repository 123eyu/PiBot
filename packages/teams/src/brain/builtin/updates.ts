/*
 * 「有新版本 / 采用新版 / 保留当前」for Bots made from a built-in role and groups made from a
 * template. The preview is computed locally (stored provenance, the shipped history, files on
 * disk; no model call). Applying goes through the app's own services — `bots.update`, the
 * permissions service, the skills port, `groups.update` / `addMember`, the built-in create path —
 * and writes audit rows; the version mark and new baseline are saved only when every step
 * succeeded, so a retry picks up exactly what is left.
 *
 * The same apply now runs on its own at start (and whenever the shipped content is
 * reloaded), for every Bot and group, including the fields the user had changed. Before it
 * replaces anything it stores the target's own values in `builtin_recoveries`, so「恢复上一版」
 * can put them back; the old「采用新版 / 保留当前」card stays for the case the automatic pass could
 * not finish.
 *
 * This file keeps the per-target serialisation and the RPC surface; reading a target's versions
 * lives in `updates/bot.ts` and `updates/group.ts`, the card in `updates/preview.ts`, the
 * restore in `updates/restore.ts`.
 */
import type { RegisterRpc } from "@pibot/brain/kit";
import type { MethodParams, MethodResults } from "@pibot/protocol";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { BotsRepo, GroupsRepo, transaction } from "@pibot/storage";
import { BuiltinBaselinesRepo } from "../../store/index.ts";
import { applyBot, autoBot, botPlan } from "./updates/bot.ts";
import {
  type Apply,
  audit,
  type BuiltinUpdateDeps,
  reason,
  type Target,
  unavailable,
} from "./updates/common.ts";
import { applyGroup, autoGroup, groupPlan } from "./updates/group.ts";
import { preview } from "./updates/preview.ts";
import { restoreBot, restoreGroup } from "./updates/restore.ts";

export class BuiltinUpdates {
  private readonly busy = new Set<string>();
  private readonly shutdown = new AbortController();
  constructor(private readonly deps: BuiltinUpdateDeps) {}
  get idle() {
    return this.busy.size === 0;
  }
  private signal() {
    return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(60_000)]);
  }
  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new RpcError(RpcErrorCodes.busy, "builtin_update_busy");
    this.busy.add(key);
    try {
      return await action();
    } finally {
      this.busy.delete(key);
    }
  }

  preview(target: Target): Promise<MethodResults["builtin.update.preview"]> {
    return preview(this.deps, () => this.signal(), target);
  }

  apply(params: Apply): Promise<MethodResults["builtin.update.apply"]> {
    if ("botId" in params)
      return this.exclusive(`bot:${params.botId}`, () =>
        applyBot(this.deps, () => this.signal(), params.botId, params),
      );
    return this.exclusive(`group:${params.groupId}`, () =>
      applyGroup(this.deps, () => this.signal(), params.groupId, params),
    );
  }

  /**
   * The automatic pass. Every Bot of a built-in role and every group of a template moves
   * to the newest version, one target at a time; a target that fails does not stop the others and
   * is retried on the next start. A version the user restored is left alone (it is recorded as
   * dismissed), a newer one is applied again.
   */
  async autoApply(): Promise<void> {
    // Never beside a user's own apply: the same Bot is serialised anyway, but the pass would
    // otherwise start over right after a「恢复上一版」.
    if (!this.idle || this.shutdown.signal.aborted) return;
    for (const bot of new BotsRepo(this.deps.db).list()) {
      if (this.shutdown.signal.aborted) return;
      if (bot.archivedAt || bot.isMain || !bot.role) continue;
      try {
        await this.exclusive(`bot:${bot.id}`, () =>
          autoBot(this.deps, () => this.signal(), bot.id),
        );
      } catch (error) {
        if (this.shutdown.signal.aborted) return;
        this.deps.logger.warn(
          JSON.stringify({
            module: "builtin",
            event: "auto_update_failed",
            botId: bot.id,
            reason: reason(error),
          }),
        );
      }
    }
    // Groups page by activity, so the pass has to walk the cursor: a limit-only read would leave
    // everything after the first page on the old version forever.
    const groups = new GroupsRepo(this.deps.db);
    let before: string | undefined;
    for (;;) {
      const page = groups.list(before ? { limit: 100, before } : { limit: 100 });
      for (const group of page) {
        if (this.shutdown.signal.aborted) return;
        try {
          await this.exclusive(`group:${group.id}`, () =>
            autoGroup(this.deps, () => this.signal(), group.id),
          );
        } catch (error) {
          if (this.shutdown.signal.aborted) return;
          this.deps.logger.warn(
            JSON.stringify({
              module: "builtin",
              event: "auto_update_failed",
              groupId: group.id,
              reason: reason(error),
            }),
          );
        }
      }
      const last = page.at(-1);
      if (page.length < 100 || !last) break;
      before = last.id;
    }
  }

  async dismiss(params: MethodParams["builtin.update.dismiss"]) {
    const repo = new BuiltinBaselinesRepo(this.deps.db);
    if ("botId" in params) {
      const found = await botPlan(this.deps, () => this.signal(), params.botId);
      if (!found || params.version !== found.plan.toVersion) throw unavailable();
      const { role, stored } = found;
      transaction(this.deps.db, () => {
        repo.dismissBot(params.botId, params.version, {
          sourceId: role.id,
          version: role.version,
          ...(stored?.baseline && stored.version === role.version
            ? { baseline: stored.baseline }
            : {}),
        });
        audit(
          this.deps,
          params.botId,
          { reasonCode: "kept", target: `${role.id}@${params.version}` },
          "Built-in update declined / 保留当前版本",
        );
      });
      this.deps.peer.emit("bots.changed", { botId: params.botId, reason: "updated" });
      return { ok: true as const };
    }
    const found = await groupPlan(this.deps, () => this.signal(), params.groupId);
    if (!found || params.version !== found.plan.toVersion) throw unavailable();
    const { origin } = found.plan;
    transaction(this.deps.db, () => {
      repo.dismissGroup(params.groupId, params.version, {
        sourceId: origin.templateId,
        version: origin.version,
        ...(origin.baseline ? { baseline: origin.baseline } : {}),
      });
      audit(
        this.deps,
        found.group.coordinatorBotId,
        {
          groupId: params.groupId,
          reasonCode: "kept",
          target: `${origin.templateId}@${params.version}`,
        },
        "Group template update declined / 保留当前版本",
      );
    });
    this.deps.peer.emit("groups.changed", { groupId: params.groupId, reason: "updated" });
    return { ok: true as const };
  }

  /** 「恢复上一版」: writes back what the last automatic update replaced. */
  restore(params: Target): Promise<MethodResults["builtin.update.restore"]> {
    if ("botId" in params)
      return this.exclusive(`bot:${params.botId}`, () =>
        restoreBot(this.deps, () => this.signal(), params.botId),
      );
    return this.exclusive(`group:${params.groupId}`, () =>
      restoreGroup(this.deps, () => this.signal(), params.groupId),
    );
  }

  async stop() {
    this.shutdown.abort();
  }
}

export function registerBuiltinUpdateRpc(handle: RegisterRpc, updates: BuiltinUpdates) {
  handle("builtin.update.preview", (params) => updates.preview(params));
  handle("builtin.update.apply", (params) => updates.apply(params));
  handle("builtin.update.dismiss", (params) => updates.dismiss(params));
  handle("builtin.update.restore", (params) => updates.restore(params));
}
