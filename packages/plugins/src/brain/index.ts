/**
 * Plugins, brain entry: `pluginsCapability` registers plugins,
 * connections, the MCP pool, built-in apps and the connector RPC with the kernel, and provides the
 * kernel's `ConnectorsPort`.
 */
export { pluginsCapability } from "./capability.ts";
export { loadBuiltinPlugins, parseDeclarativePlugin } from "./declarative-loader.ts";
