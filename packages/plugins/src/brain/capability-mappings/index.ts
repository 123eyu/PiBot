import type { Connector, ConnectorTool, PluginInstallation } from "@pibot/plugins-contract/full";
import type { PluginRegistry } from "../apps/registry.ts";
import { browserMapping } from "./browser.ts";
import { filesReadMapping } from "./files-read.ts";
import { filesWriteMapping } from "./files-write.ts";
import type { CapabilityMapping, DiscoveredConnectorTool } from "./types.ts";
import { webFetchMapping } from "./web-fetch.ts";
import { webSearchMapping } from "./web-search.ts";

export const CAPABILITY_MAPPINGS: readonly CapabilityMapping[] = [
  filesReadMapping,
  filesWriteMapping,
  webFetchMapping,
  webSearchMapping,
  browserMapping,
];

export function mapConnectorCapabilities(input: {
  registry: PluginRegistry;
  connector: Connector;
  plugin: PluginInstallation;
  tools: readonly DiscoveredConnectorTool[];
}): Array<
  DiscoveredConnectorTool &
    Partial<Pick<ConnectorTool, "capabilityId" | "capabilityTool" | "capabilityReadOnly">>
> {
  const toolNames = new Set(input.tools.map((tool) => tool.tool));
  const appCapability = input.registry.capability(input.plugin);
  const appMapping: CapabilityMapping | undefined = appCapability
    ? {
        capabilityId: appCapability.id,
        match: () => true,
        tools: appCapability.tools,
        readOnlyTools: appCapability.readOnlyTools,
      }
    : undefined;
  const mappings = [...CAPABILITY_MAPPINGS, ...(appMapping ? [appMapping] : [])].filter((mapping) =>
    mapping.match({ connector: input.connector, plugin: input.plugin, toolNames }),
  );
  return input.tools.map((tool) => {
    const matches = mappings.flatMap((mapping) => {
      const capabilityTool = mapping.tools[tool.tool];
      return capabilityTool
        ? [
            {
              capabilityId: mapping.capabilityId,
              capabilityTool,
              capabilityReadOnly: mapping.readOnlyTools.has(tool.tool),
            },
          ]
        : [];
    });
    if (matches.length > 1)
      throw new TypeError(`Connector tool maps to multiple capabilities: ${tool.tool}`);
    return matches[0] ? { ...tool, ...matches[0] } : tool;
  });
}

export type { CapabilityMapping } from "./types.ts";
