import type { CapabilityImpl, CapabilitySetParams } from "@pibot/protocol-base";
import { BotsRepo, transaction } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../../core/business-rpc.ts";
import type { LocalService } from "../../../local-service.ts";

function implType(impl: CapabilityImpl): "builtin" | "connector" | "off" {
  if (impl === "builtin" || impl === "off") return impl;
  return "connector";
}

function effectiveParams(params: CapabilitySetParams) {
  if (params.scope === "bot") return { botId: params.scopeId };
  if (params.scope === "group") return { groupId: params.scopeId };
  return {};
}

export function registerCapabilityRpc(handle: KernelRegisterRpc, local: LocalService): void {
  handle("capabilities.list", async (params) => local.capabilities.list(params));
  handle("capabilities.set", async (params) => {
    // Peer already validated the zod boundary. Its input type widens the transformed connector
    // string; inside the boundary it is the protocol's narrowed output type.
    const selection = params as CapabilitySetParams;
    local.capabilities.validateSet(selection);
    const actor = new BotsRepo(local.deps.db).getMain();
    if (!actor) throw new Error("Main Bot missing while changing a capability");
    transaction(local.deps.db, () => {
      local.capabilities.write(selection);
      const effective = local.capabilities
        .list(effectiveParams(selection))
        .items.find((item) => item.id === selection.capabilityId);
      if (!effective) throw new Error("Capability missing after selection update");
      local.approvals.audit.append({
        botId: actor.id,
        kind: "capability.changed",
        summary: "Capability selection changed",
        detail: {
          capabilityId: selection.capabilityId,
          capabilityImpl: implType(effective.impl),
        },
      });
    });
    local.deps.peer.emit("capabilities.changed", {
      scope: selection.scope,
      ...(selection.scopeId ? { scopeId: selection.scopeId } : {}),
      capabilityId: selection.capabilityId,
    });
    return null;
  });
}
