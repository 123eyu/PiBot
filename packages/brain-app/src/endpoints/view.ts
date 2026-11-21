import type {
  EndpointCapabilityDefinition,
  EndpointCapabilityRow,
  EndpointPresence,
} from "@pibot/protocol-base";

export function endpointCapabilityView(
  row: EndpointCapabilityRow,
  definition: EndpointCapabilityDefinition | undefined,
  online: boolean,
  presence: EndpointPresence | undefined,
) {
  const deviceName = presence?.name ?? row.endpointId;
  return {
    ...row,
    online,
    endpointKind:
      row.endpointId === "local" ? ("desktop" as const) : (definition?.kind ?? ("runner" as const)),
    endpointName:
      row.endpointId === "local"
        ? { zh: "这台电脑", en: "This computer" }
        : { zh: deviceName, en: deviceName },
    name: definition?.name ?? { zh: "未知能力", en: "Unknown capability" },
  };
}
