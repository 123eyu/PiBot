import type { Connector } from "@pibot/plugins-contract/full";

/** The enabled preference alone does not mean an unavailable connection is running. */
export function connectorSwitchChecked(connector: Pick<Connector, "enabled" | "status">) {
  return connector.enabled && !["needs_setup", "needs_auth", "error"].includes(connector.status);
}

/**
 * A local MCP running without any sandbox — the person's switch on macOS / Linux, or
 * every local MCP on Windows. Shown as a badge wherever the connection is listed.
 */
export function runsOutsideSandbox(
  connector: Pick<Connector, "kind" | "outsideSandbox">,
  platform: string | undefined,
) {
  return connector.kind === "mcp_stdio" && (connector.outsideSandbox || platform === "win32");
}

/** Old system failures were misfiled as missing credentials; their actual cause is unknown. */
export function connectionFailureCode<T extends string | null | undefined>(
  code: T,
  systemAuth: boolean,
) {
  return systemAuth && code === "secret_required" ? "connection_failed" : code;
}
