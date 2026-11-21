import { type MethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol";
import {
  OFFLINE_MAX_PROVIDERS,
  OFFLINE_MAX_VIEW_MODELS,
  type OfflineDeviceView,
  OfflineDeviceViewSchema,
  OfflineMethods,
} from "@pibot/remote-contract";
import { AuditRepo, BotsRepo, transaction } from "@pibot/storage";
import { RemoteOfflineRepo } from "../../store/index.ts";
import type { RemoteResources } from "../runtime/context.ts";
import { OfflineImport } from "./import.ts";
import { OfflineModels } from "./models.ts";
import { OfflineSnapshots } from "./snapshot.ts";

export type OfflinePhoneMethod =
  | "remote.runnerControl.pull"
  | "remote.offline.manifest"
  | "remote.offline.snapshot"
  | "remote.offline.upload";
export const isOfflinePhoneMethod = (method: string): method is OfflinePhoneMethod =>
  method === "remote.runnerControl.pull" ||
  method === "remote.offline.manifest" ||
  method === "remote.offline.snapshot" ||
  method === "remote.offline.upload";

/**
 * The computer side of a phone's direct model use. The user chooses models and Bots per
 * phone and clicks 「下发」; only then may a key travel, and only over that phone's authenticated
 * session in answer to its own manifest request. Un-checking, revoking or unpairing removes the
 * grant and tells the phone to clear. Every grant change and every key sent is audited, never the
 * key itself.
 */
export class RemoteOfflineService {
  runnerControl?: (
    id: string,
    after?: string,
  ) => Promise<import("@pibot/protocol").MethodResults["remote.runnerControl.pull"]>;
  readonly repo: RemoteOfflineRepo;
  private readonly models: OfflineModels;
  private readonly snapshots: OfflineSnapshots;
  private readonly importer: OfflineImport;
  constructor(
    private readonly r: RemoteResources,
    /** Tells that phone to pull again (or, with clear, to drop all it holds). */
    private readonly notify: (deviceId: string, payload: { clear?: true }) => void,
  ) {
    this.repo = new RemoteOfflineRepo(r.ctx.db);
    this.models = new OfflineModels(r);
    this.snapshots = new OfflineSnapshots(r, this.repo, this.models);
    this.importer = new OfflineImport(r, this.repo, () => this.snapshots.language());
  }
  private phone(deviceId: string) {
    const device = this.r.devices.active(deviceId);
    if (device.kind !== "phone")
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_device_unavailable");
    return device;
  }
  private audit(
    deviceId: string,
    outcome: string,
    actor: "user" | "automatic",
    model?: { providerId: string; modelId: string },
  ) {
    new AuditRepo(this.r.ctx.db, this.r.ctx.redactor).append({
      botId: new BotsRepo(this.r.ctx.db).getMain()?.id ?? "",
      kind: "remote.changed",
      summary: "Phone direct model use / 手机直接用模型",
      detail: {
        actor,
        deviceId,
        target: "remote.offline",
        reasonCode: outcome,
        // T7: a grant is per provider; its modelId is empty, and the audit schema needs a real id.
        ...(model
          ? { providerId: model.providerId, ...(model.modelId ? { modelId: model.modelId } : {}) }
          : {}),
      },
    });
  }
  async view(deviceId: string): Promise<OfflineDeviceView> {
    this.phone(deviceId);
    await this.syncGrants(deviceId);
    const grants = this.repo.grants(deviceId);
    const models: OfflineDeviceView["models"] = [];
    for (const candidate of (await this.models.candidates(grants)).slice(
      0,
      OFFLINE_MAX_VIEW_MODELS,
    )) {
      const grant = grants.find((g) => g.providerId === candidate.providerId);
      const unavailable = await this.models.unavailable(candidate.providerId, candidate.modelId);
      models.push({
        providerId: candidate.providerId,
        providerName: (
          this.models.providerName(candidate.providerId) || candidate.providerId
        ).slice(0, 200),
        modelId: candidate.modelId,
        modelName: (
          (await this.models.modelName(candidate.providerId, candidate.modelId)) ||
          candidate.modelId
        ).slice(0, 200),
        ...(unavailable ? { unavailable } : {}),
        selected: !!grant,
        delivered: !!grant?.deliveredAt,
      });
    }
    // Agent Bots have no switch to show: they are never available offline.
    const bots = this.snapshots.activeBots().filter((bot) => bot.kind !== "agent");
    const usable = await this.snapshots.usableModels(grants, bots);
    const offline = this.snapshots.enabled(deviceId);
    const result = {
      deviceId,
      models,
      bots: bots.map((bot) => {
        const model = this.snapshots.grantFor(bot, usable);
        return {
          botId: bot.id,
          name: bot.name.slice(0, 200),
          offline: offline.has(bot.id),
          modelName: model?.modelName ?? null,
        };
      }),
      pending: grants.some((grant) => !grant.deliveredAt),
    };
    const checked = OfflineDeviceViewSchema.safeParse(result);
    if (!checked.success) {
      throw new RpcError(
        RpcErrorCodes.internal,
        `offline_view_invalid:${checked.error.issues[0]?.path.join(".") ?? "unknown"}`,
      );
    }
    return result;
  }
  /**
   * Maintainers 2026-11-12 (自动同步，保留每个 Bot 的开关): the models of the Bots that may answer
   * offline are this phone's grants, delivered without a separate click; a model no longer used
   * is withdrawn (the phone is told to clear its key). Runs before every view and phone pull.
   */
  private async syncGrants(deviceId: string) {
    // T7 changes the unit of choice from a Bot's current model to the provider catalog. Every
    // portable model from an eligible API-key provider follows the provider; Bot switches only
    // control whether that Bot may answer offline.
    const wanted: { providerId: string; modelId: string }[] = [];
    const providers = new Set<string>();
    for (const candidate of await this.models.candidates(this.repo.grants(deviceId))) {
      if (await this.models.unavailable(candidate.providerId, candidate.modelId)) continue;
      if (!providers.has(candidate.providerId) && providers.size >= OFFLINE_MAX_PROVIDERS) continue;
      providers.add(candidate.providerId);
      wanted.push(candidate);
    }
    let changed = false;
    transaction(this.r.ctx.db, () => {
      const before = new Set(this.repo.grants(deviceId).map((g) => g.grantId));
      for (const removed of this.repo.setGrants(deviceId, wanted)) {
        changed = true;
        this.audit(
          deviceId,
          removed.deliveredAt ? "key_cleared" : "model_removed",
          "automatic",
          removed,
        );
      }
      for (const added of this.repo.grants(deviceId))
        if (!before.has(added.grantId)) {
          changed = true;
          this.audit(deviceId, "model_synced", "automatic", added);
        }
      this.repo.deliverAll(deviceId);
    });
    return changed;
  }
  async set(deviceId: string, input: MethodParams["remote.offline.set"]) {
    this.phone(deviceId);
    const bot = input.bot;
    if (!this.snapshots.activeBots().some((entry) => entry.id === bot.botId))
      throw new RpcError(RpcErrorCodes.invalidParams, "offline_bot_unavailable");
    transaction(this.r.ctx.db, () => {
      this.repo.setBot(deviceId, bot.botId, bot.offline);
      this.audit(deviceId, bot.offline ? "bot_offline_on" : "bot_offline_off", "user");
    });
    await this.syncGrants(deviceId);
    this.notify(deviceId, {});
    return this.view(deviceId);
  }
  /** Revoke / unpair: inside the caller's transaction; the phone is told before its link closes. */
  clear(deviceId: string) {
    for (const removed of this.repo.clearDevice(deviceId))
      this.audit(deviceId, "key_cleared", "user", removed);
  }
  clearNotice(deviceId: string) {
    this.notify(deviceId, { clear: true });
  }
  /** Phone gateway entry; the gateway already checked the session and allowlist. */
  async handle(deviceId: string, method: OfflinePhoneMethod, input: unknown, signal: AbortSignal) {
    this.phone(deviceId);
    if (method === "remote.runnerControl.pull") {
      const { RunnerControlMethods } = await import("@pibot/remote-contract");
      const params = RunnerControlMethods[method].params.parse(input);
      if (!this.runnerControl)
        throw new RpcError(RpcErrorCodes.unsupported, "runner_control_unsupported");
      return this.runnerControl(deviceId, params.after);
    }
    if (method === "remote.offline.snapshot") {
      const { botId } = OfflineMethods[method].params.parse(input);
      return this.snapshots.forBot(deviceId, botId, signal);
    }
    if (method === "remote.offline.upload")
      return this.importer.upload(deviceId, OfflineMethods[method].params.parse(input), signal);
    const params = OfflineMethods[method].params.parse(input);
    await this.syncGrants(deviceId);
    const manifest = await this.snapshots.manifest(deviceId, signal);
    const held = new Map(params.keys.map((key) => [key.grantId, key.digest]));
    const keys: { grantId: string; key: string; digest: string }[] = [];
    const sent = new Set<string>();
    for (const model of manifest.models) {
      if (!model.delivered) continue;
      if (sent.has(model.grantId)) continue;
      sent.add(model.grantId);
      const key = await this.models.key(model.providerId);
      signal.throwIfAborted();
      if (!key || held.get(model.grantId) === key.digest) continue;
      // A key changed on the computer reaches the phone the same way, without another click.
      keys.push({ grantId: model.grantId, ...key });
      this.r.ctx.redactor.add(key.key);
      for (const value of Object.values(key.headers ?? {})) this.r.ctx.redactor.add(value);
      this.audit(deviceId, "key_sent", "automatic", model);
    }
    return {
      version: manifest.version,
      ...(params.ifVersion === manifest.version ? {} : { manifest }),
      keys,
    };
  }
}
