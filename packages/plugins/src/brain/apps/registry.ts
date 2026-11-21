import type { McpCapability, Plugin } from "@pibot/plugin-sdk";
import type {
  BuiltinApp,
  BuiltinAppConnect,
  Connector,
  ConnectorManifest,
  PluginInstallation,
} from "@pibot/plugins-contract/full";
import { BuiltinAppSchema, ConnectorManifestSchema } from "@pibot/plugins-contract/full";

const pluginPrefix = "pibot.";
const appIdPattern = /^[a-z][a-z0-9.-]{1,63}$/;

export interface McpToolPolicy {
  readOnly: boolean;
  enabled: boolean;
  draftBinding: ReturnType<NonNullable<NonNullable<Plugin["mcp"]>["draftBinding"]>>;
}

export class PluginRegistry {
  private readonly byId = new Map<string, Plugin>();

  constructor(apps: readonly Plugin[]) {
    for (const app of apps) {
      if (!appIdPattern.test(app.id)) throw new TypeError(`Invalid MCP app id: ${app.id}`);
      if (this.byId.has(app.id)) throw new TypeError(`Duplicate MCP app id: ${app.id}`);
      this.byId.set(app.id, app);
    }
  }

  get(id: string): Plugin | undefined {
    return this.byId.get(id);
  }

  definitions(): readonly Plugin[] {
    return [...this.byId.values()];
  }

  fromPluginId(pluginId: string): Plugin | undefined {
    if (!pluginId.startsWith(pluginPrefix)) return undefined;
    return this.byId.get(pluginId.slice(pluginPrefix.length));
  }

  fromInstallation(plugin: PluginInstallation | undefined): Plugin | undefined {
    return plugin?.sourceKind === "builtin" ? this.fromPluginId(plugin.pluginId) : undefined;
  }

  list(platform: NodeJS.Platform): BuiltinApp[] {
    return [...this.byId.values()]
      .filter((plugin) => plugin.mcp)
      .map((plugin) => BuiltinAppSchema.parse(plugin.card(platform)));
  }

  manifest(input: BuiltinAppConnect, credentialName?: string): ConnectorManifest {
    const plugin = this.byId.get(input.appId);
    const mcp = plugin?.mcp;
    const card = plugin && BuiltinAppSchema.parse(plugin.card("darwin"));
    if (!plugin || !mcp || !card?.modes.some((mode) => mode.id === input.mode))
      throw new Error("Unsupported application mode");
    const server = mcp.server({ mode: input.mode, credentialName });
    return ConnectorManifestSchema.parse({
      schemaVersion: 1,
      id: `${pluginPrefix}${plugin.id}`,
      version: plugin.version,
      name: card.name,
      description: card.description,
      servers: [server],
    });
  }

  appId(connector: Connector, plugin: PluginInstallation | undefined): Connector["appId"] {
    const registered = this.fromInstallation(plugin);
    return registered?.mcp ? (registered.id as NonNullable<Connector["appId"]>) : connector.appId;
  }

  /** Pre-release T4 rows used `builtin`; derive the immutable T5 stdio preset without trusting row input. */
  effectiveServer(
    plugin: PluginInstallation | undefined,
    server: import("@pibot/plugins-contract/full").ConnectorServer,
  ): import("@pibot/plugins-contract/full").ConnectorServer {
    const registered = this.fromInstallation(plugin);
    const mcp = registered?.mcp;
    if (!registered || !mcp) return server;
    const legacy = mcp.legacyBuiltinMode?.(server);
    if (legacy) return mcp.server({ mode: legacy, credentialName: server.auth.secretNames[0] });
    // A bundled server's command is this build's executable and script path; a stored copy goes
    // stale when the app moves, updates or runs as a dev build, so it is always derived here.
    if (server.transport !== "stdio" || !mcp.trustedStdio) return server;
    const preset = registered
      .card("darwin")
      .modes.map((entry) => entry.id)
      .map((mode) => mcp.server({ mode, credentialName: server.auth.secretNames[0] }))
      .find(
        (candidate) =>
          candidate.transport === "stdio" &&
          candidate.auth.kind === server.auth.kind &&
          Object.entries(candidate.env).every(([key, value]) => server.env[key] === value),
      );
    if (preset?.transport !== "stdio") return server;
    return preset;
  }

  toolPolicy(
    pluginId: string,
    tool: string,
    schema?: unknown,
    args?: Record<string, unknown>,
  ): McpToolPolicy {
    const mcp = this.fromPluginId(pluginId)?.mcp;
    return {
      readOnly: mcp?.trustedReads.has(tool) === true,
      enabled: mcp?.defaultEnabled(tool) ?? true,
      draftBinding: mcp?.draftBinding?.(tool, schema, args),
    };
  }

  capability(plugin: PluginInstallation): McpCapability | undefined {
    return this.fromInstallation(plugin)?.mcp?.capability;
  }
}
