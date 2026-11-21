import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { LocalService } from "../../local-service.ts";
import type { ManagedResourcesPort } from "./port.ts";
/** Resolve at call time: capabilities register after the kernel's routes and consumers exist. */
export function workspaceResources(local: LocalService): ManagedResourcesPort {
  const current = () => {
    if (!local.workspaceServices)
      throw new RpcError(RpcErrorCodes.unsupported, "workspaces_unavailable");
    return local.workspaceServices.resources;
  };
  return {
    retry: (target, action) => current().retry(target, action),
    checkpoints: { restore: (input, signal) => current().checkpoints.restore(input, signal) },
    captureDrained: (context, record, signal) =>
      local.workspaceServices?.resources.captureDrained(context, record, signal) ??
      Promise.resolve(),
    beginBrowserTakeover: (botId) => current().beginBrowserTakeover(botId),
    dispose: () => local.workspaceServices?.dispose() ?? Promise.resolve(),
  };
}
