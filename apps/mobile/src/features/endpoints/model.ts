import { endpointCapabilityCatalog, type MethodParams, type MethodResults } from "@pibot/protocol";

export type EndpointPage = MethodResults["endpoints.list"];
export type EndpointRow = EndpointPage["items"][number];
export type EndpointChange = MethodParams["endpoints.capability.set"];
export type Scope = EndpointChange["scope"];

export const endpointPageSize = 10;
const definitions = new Map<string, (typeof endpointCapabilityCatalog)[number]>(
  endpointCapabilityCatalog.map((definition) => [definition.id, definition]),
);

export function sensitive(row: EndpointRow) {
  const definition = definitions.get(row.capabilityId);
  if (!definition || definition.version !== row.version || definition.kind !== row.endpointKind)
    return true;
  const { readOnly, privacy, egress, writesFile } = definition.attributes;
  return !readOnly || privacy || egress || writesFile;
}

function widens(before: string[] | null, after: string[] | null) {
  if (before === null) return false;
  const allowed = new Set(before);
  return after === null || after.some((id) => !allowed.has(id));
}

export function changeFor(row: EndpointRow, enabled: boolean, scope = row.scope): EndpointChange {
  return {
    endpointId: row.endpointId,
    capabilityId: row.capabilityId,
    enabled,
    scope,
    expected: { version: row.version, state: row.state, scope: row.scope },
  };
}

export function requiresBiometric(row: EndpointRow, enabled: boolean, scope: Scope) {
  return (
    sensitive(row) &&
    ((enabled && row.state === "off") ||
      widens(row.scope.botIds, scope.botIds) ||
      widens(row.scope.groupIds, scope.groupIds))
  );
}
