import {
  CAPABILITIES,
  type CapabilityId,
  type CapabilityImpl,
  CapabilityImplSchema,
} from "@pibot/protocol-base";

export interface CapabilityResolver {
  resolve(scope: { botId: string; groupId?: string }): ReadonlyMap<CapabilityId, CapabilityImpl>;
}

/**
 * Baseline selection only. Persisted overrides and permission narrowing belong to T2; connector
 * capability mappings belong to T3. The supplied map is capability id -> connected instance id.
 */
export function defaultCapabilityResolver(
  connectedConnectors: ReadonlyMap<CapabilityId, string> = new Map(),
): CapabilityResolver {
  return {
    resolve(_scope) {
      return new Map(
        CAPABILITIES.map((capability) => {
          if (capability.hasBuiltin) return [capability.id, "builtin"] as const;
          const connectorId = connectedConnectors.get(capability.id);
          return [
            capability.id,
            connectorId ? CapabilityImplSchema.parse(`connector:${connectorId}`) : ("off" as const),
          ] as const;
        }),
      );
    },
  };
}
