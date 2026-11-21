import type { BrainCapability } from "@pibot/brain/kit";
import { AuditRepo, BotsRepo } from "@pibot/storage";
import { RemoteDevicesRepo, RemoteReceiptsRepo, RemoteSettingsRepo } from "../../store/index.ts";
import type { PhoneWriteFacts } from "../rpc/settings-allowlist.ts";
export type RemoteContext = Parameters<BrainCapability["register"]>[0];
export function remoteResources(ctx: RemoteContext) {
  const audit = new AuditRepo(ctx.db, ctx.redactor);
  const bots = new BotsRepo(ctx.db);
  return {
    ctx,
    devices: new RemoteDevicesRepo(ctx.db),
    settings: new RemoteSettingsRepo(ctx.db),
    receipts: new RemoteReceiptsRepo(ctx.db),
    secrets: ctx.secrets,
    audit(
      deviceId: string | undefined,
      method: string,
      outcome: string,
      actor: "user" | "phone" | "automatic" = deviceId ? "phone" : "user",
      facts?: PhoneWriteFacts,
    ) {
      // A settings write is filed under the Bot it changed, so the Bot's activity list shows it.
      const target = facts?.botId && bots.get(facts.botId) ? facts.botId : undefined;
      audit.append({
        botId: target ?? bots.getMain()?.id ?? "",
        kind: actor === "phone" ? "remote.request" : "remote.changed",
        summary:
          actor === "phone"
            ? "Mobile remote action / 手机远控操作"
            : "Remote device action / 远程设备操作",
        detail: {
          actor,
          ...(deviceId ? { deviceId } : {}),
          target: method,
          reasonCode: outcome,
          ...(facts?.fields.length ? { fields: facts.fields } : {}),
          ...(facts?.groupId ? { groupId: facts.groupId } : {}),
          ...(facts?.targetBotId ? { targetBotId: facts.targetBotId } : {}),
        },
      });
    },
    changed() {
      ctx.ports
        .get<import("@pibot/protocol-base").EndpointRegistrySource>("endpoints.registry")
        ?.refresh();
      ctx.peer.emit("devices.changed", {});
    },
  };
}
export type RemoteResources = ReturnType<typeof remoteResources>;
