import type { CapabilityId, CapabilityImpl, ConnectorTool } from "@pibot/protocol-base";
import type { ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";
import { adaptedCapabilityTool } from "./capability-tools.ts";

export function resolvedConnectorCapabilities(
  local: LocalService,
  context: ToolRunContext,
): ReadonlyMap<CapabilityId, CapabilityImpl> {
  // Freezes the selection at run start; the MCP side must agree with the built-in side
  // even if the user changes a setting mid-run.
  return (
    context.capabilities ??
    local.capabilities.resolve({
      botId: context.botId,
      ...(context.groupId ? { groupId: context.groupId } : {}),
    })
  );
}

function served(
  selections: ReadonlyMap<CapabilityId, CapabilityImpl>,
  tool: ConnectorTool,
): boolean {
  if (!tool.capabilityId) return true;
  const impl = selections.get(tool.capabilityId);
  return impl === `connector:${tool.connectorId}`;
}

export function connectorCapabilitySelected(
  local: LocalService,
  context: ToolRunContext,
  tool: ConnectorTool,
): boolean {
  return served(resolvedConnectorCapabilities(local, context), tool);
}

export function filterConnectorCapabilities(
  local: LocalService,
  context: ToolRunContext,
  tools: readonly ConnectorTool[],
  selections = resolvedConnectorCapabilities(local, context),
): ConnectorTool[] {
  return tools.filter(
    (tool) => tool.enabled && !adaptedCapabilityTool(tool) && served(selections, tool),
  );
}
