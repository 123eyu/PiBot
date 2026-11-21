import type { EndpointCapabilityDefinition } from "@pibot/protocol-base";
import { registerLocal } from "./local.ts";
import { EndpointCapabilityRegistry } from "./registry.ts";

export function endpointCapability(
  catalog: readonly EndpointCapabilityDefinition[],
  isPhoneRequest: () => boolean,
): import("@pibot/brain").BrainCapability {
  return {
    id: "endpoints",
    register(ctx) {
      const registry = new EndpointCapabilityRegistry(ctx, catalog);
      ctx.local.endpoints = registry;
      ctx.ports.provide("endpoints.registry", registry);
      registerLocal(registry, ctx, catalog);
      ctx.rpc.handle("endpoints.list", ({ after, limit, endpointId }) =>
        registry.list(after, limit, endpointId),
      );
      ctx.rpc.handle("endpoints.capability.set", (input) => registry.set(input, isPhoneRequest()));
      return {
        stop: async () => {
          ctx.local.endpoints = undefined;
          registry.dispose();
        },
      };
    },
  };
}
