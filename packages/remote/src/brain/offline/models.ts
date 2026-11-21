import { createHash } from "node:crypto";
import { isChatGPTPlanProvider, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { OfflineDeviceView, OfflineModel } from "@pibot/remote-contract";
import { BotsRepo } from "@pibot/storage";
import type { OfflineGrantRecord } from "../../store/index.ts";
import type { RemoteResources } from "../runtime/context.ts";

type Unavailable = NonNullable<OfflineDeviceView["models"][number]["unavailable"]>;
/**
 * A fingerprint the phone echoes to say which key it holds. Namespaced, so it cannot be matched
 * against plain SHA-256 values of keys seen elsewhere (Claude review 2026-11-12).
 */
export const digest = (value: string) =>
  createHash("sha256").update("pibot.offline.key.v1\0").update(value).digest("hex");

/**
 * Only API-key providers and custom OpenAI/Anthropic-compatible ones go to a phone. A
 * subscription login (OAuth) would be refreshed by both sides and invalidate itself (待决定 2);
 * cloud credentials stay on the computer; custom request headers travel with the key (maintainers 2026-11-12).
 */
export class OfflineModels {
  constructor(private readonly r: RemoteResources) {}
  private get providers() {
    const models = this.r.ctx.local.models;
    if (!models) throw new RpcError(RpcErrorCodes.unsupported, "model_providers_unavailable");
    return models;
  }
  async unavailable(providerId: string, modelId: string): Promise<Unavailable | undefined> {
    const providers = this.providers;
    const mode = providers.auth.mode(providerId);
    // The ChatGPT plan by id too: its models use a portable API, and its sign-in must never be
    // refreshed from a second device.
    if (mode === "oauth" || isChatGPTPlanProvider(providerId)) return "subscription";
    if (mode === "cloud") return "cloud";
    // Maintainers 2026-11-12: custom headers go to the phone like the key, so they no longer exclude a model.
    if (!providers.hasApiKey(providerId)) return "no_key";
    const model = await this.r.ctx.agent.portableModel?.(providerId, modelId);
    if (!model) return "protocol";
    return undefined;
  }
  /** T7: a grant represents one catalog model, but the selection unit is its provider. */
  async candidates(grants: readonly OfflineGrantRecord[]) {
    const seen = new Map<string, { providerId: string; modelId: string }>();
    for (const bot of new BotsRepo(this.r.ctx.db).list())
      if (!bot.archivedAt && bot.modelProvider && bot.modelId)
        seen.set(JSON.stringify([bot.modelProvider, bot.modelId]), {
          providerId: bot.modelProvider,
          modelId: bot.modelId,
        });
    for (const model of await this.r.ctx.agent.listModels({ availableOnly: true }))
      seen.set(JSON.stringify([model.provider, model.id]), {
        providerId: model.provider,
        modelId: model.id,
      });
    for (const grant of grants)
      if (grant.modelId)
        seen.set(JSON.stringify([grant.providerId, grant.modelId]), {
          providerId: grant.providerId,
          modelId: grant.modelId,
        });
    return [...seen.values()];
  }
  providerName(providerId: string) {
    return this.providers.providerName(providerId) ?? providerId;
  }
  async modelName(providerId: string, modelId: string) {
    const listed = (await this.r.ctx.agent.listModels({ availableOnly: true })).find(
      (model) => model.provider === providerId && model.id === modelId,
    );
    return listed?.name ?? modelId;
  }
  /** The manifest entry of one grant; undefined when it cannot be used now (key removed, …). */
  async describe(
    grant: OfflineGrantRecord,
    thinkingLevel: OfflineModel["thinkingLevel"],
    modelId = grant.modelId,
  ): Promise<OfflineModel | undefined> {
    if (await this.unavailable(grant.providerId, modelId)) return undefined;
    const model = await this.r.ctx.agent.portableModel?.(grant.providerId, modelId);
    if (!model) return undefined;
    return {
      grantId: grant.grantId,
      providerId: grant.providerId,
      providerName: this.providerName(grant.providerId).slice(0, 200),
      modelId: model.id,
      modelName: model.name.slice(0, 200) || model.id.slice(0, 200),
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: model.input.length ? model.input : ["text"],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevel,
      cost: model.cost,
      delivered: !!grant.deliveredAt,
    };
  }
  /** The key itself, read only to hand it to the phone that the user delivered it to. */
  async key(providerId: string) {
    const key = await this.providers.getApiKey(providerId);
    if (!key) return undefined;
    // Header values are stored encrypted like the key; load them before reading the config.
    await this.providers.credentials(providerId);
    const custom = this.providers.customProviders().find((entry) => entry.id === providerId);
    const headers =
      custom?.headers && Object.keys(custom.headers).length ? { ...custom.headers } : undefined;
    return {
      key,
      ...(headers ? { headers } : {}),
      // A changed header follows to the phone the same way a changed key does.
      digest: digest(JSON.stringify([key, headers ?? {}])),
    };
  }
}
