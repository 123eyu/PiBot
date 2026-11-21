import {
  appCapabilityTools,
  CAPABILITIES,
  type CapabilityId,
  type ConnectorTool,
} from "@pibot/protocol-base";

interface CapabilityConnectorTool {
  raw: readonly string[];
  readOnly: boolean;
}

/** Reviewed stable adapters. Order chooses between equivalent raw connector aliases. */
export const CAPABILITY_CONNECTOR_TOOLS: Readonly<
  Partial<Record<CapabilityId, Readonly<Record<string, CapabilityConnectorTool>>>>
> = {
  "files.read": {
    read_file: { raw: ["read_text_file", "read_file"], readOnly: true },
    list_dir: { raw: ["list_directory"], readOnly: true },
    find_files: { raw: ["search_files"], readOnly: true },
  },
  "web.fetch": { web_fetch: { raw: ["fetch"], readOnly: true } },
  browser: {
    browser_snapshot: { raw: ["browser_snapshot"], readOnly: true },
    browser_tabs: { raw: ["browser_tabs"], readOnly: true },
    browser_screenshot: {
      raw: ["browser_take_screenshot", "browser_screenshot"],
      readOnly: true,
    },
    browser_wait: { raw: ["browser_wait_for"], readOnly: true },
  },
};

export function adaptedCapabilityTool(tool: ConnectorTool): boolean {
  if (!tool.capabilityId || !tool.capabilityTool) return false;
  const adapter = CAPABILITY_CONNECTOR_TOOLS[tool.capabilityId]?.[tool.capabilityTool];
  if (adapter)
    return adapter.readOnly === tool.capabilityReadOnly && adapter.raw.includes(tool.tool);
  const capability = CAPABILITIES.find((item) => item.id === tool.capabilityId);
  const definition = appCapabilityTools[tool.capabilityTool as keyof typeof appCapabilityTools];
  return (
    capability?.permissionCategory === "connector" &&
    (capability.builtinTools as readonly string[]).includes(tool.capabilityTool) &&
    definition !== undefined &&
    definition.policy.readOnly === tool.capabilityReadOnly
  );
}
