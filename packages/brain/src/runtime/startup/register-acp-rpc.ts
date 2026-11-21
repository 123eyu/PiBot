import {
  type AcpAttachmentPort,
  type KernelEvents,
  type KernelMethods,
  type Peer,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import type { AuditRepo, BotsRepo } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { BrainRedactor } from "../../core/privacy.ts";

/** Lifecycle metadata comes from the local transport owner, not a public RPC. */
export function registerAcpRpc(ctx: {
  handle: KernelRegisterRpc;
  peer: Peer<typeof KernelMethods, typeof KernelEvents>;
  audit: AuditRepo;
  bots: Pick<BotsRepo, "getMain">;
  redactor: BrainRedactor;
  acp?: AcpAttachmentPort;
}) {
  const state = () => {
    const value = ctx.acp?.state();
    return value?.connected
      ? {
          connected: true as const,
          client: {
            name: ctx.redactor.redact(value.client.name).slice(0, 120) || "Editor",
            version: ctx.redactor.redact(value.client.version).slice(0, 100) || "unknown",
          },
        }
      : { connected: false as const };
  };
  ctx.handle("acp.state", async () => state());
  ctx.handle("acp.disconnect", async (_params, { signal, source }) => {
    if (source === "acp")
      throw new RpcError(RpcErrorCodes.methodNotFound, "acp_method_unavailable");
    await ctx.acp?.disconnect(signal);
    return { ok: true };
  });
  const off = ctx.acp?.subscribe((event) => {
    const client =
      "client" in event
        ? {
            name: ctx.redactor.redact(event.client.name).slice(0, 120),
            version: ctx.redactor.redact(event.client.version).slice(0, 100),
          }
        : undefined;
    const botId =
      event.kind === "acp.session.new" || event.kind === "acp.session.attach"
        ? event.botId
        : ctx.bots.getMain()?.id;
    if (!botId) throw new RpcError(RpcErrorCodes.closed, "acp_bot_unavailable");
    ctx.audit.append({
      botId,
      kind: event.kind,
      summary: event.kind,
      detail:
        event.kind === "acp.session.new" || event.kind === "acp.session.attach"
          ? {
              conversationId: event.topicId,
              acpFolders: event.folders.map((path) => ctx.redactor.redact(path).slice(0, 32768)),
            }
          : { acpClient: client },
    });
    if (event.kind !== "acp.session.new" && event.kind !== "acp.session.attach") {
      ctx.peer.emit("acp.changed", state());
    }
  });
  return {
    async stop() {
      off?.();
    },
  };
}
