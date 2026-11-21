import type {
  CapabilityId,
  Connector,
  ConnectorTool,
  PluginInstallation,
} from "@pibot/plugins-contract/full";

export interface CapabilityMatchInput {
  connector: Connector;
  plugin: PluginInstallation;
  toolNames: ReadonlySet<string>;
}

export interface CapabilityMapping {
  capabilityId: CapabilityId;
  match(input: CapabilityMatchInput): boolean;
  tools: Readonly<Record<string, string>>;
  readOnlyTools: ReadonlySet<string>;
}

export type DiscoveredConnectorTool = Pick<
  ConnectorTool,
  | "tool"
  | "description"
  | "schema"
  | "suggestedReadOnly"
  | "readOnlyHint"
  | "idempotentHint"
  | "destructiveHint"
>;
