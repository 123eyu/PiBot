// Which Pi Bot tools an external agent gets through the `pibot` bridge, with the exact
// names, descriptions and schemas Pi Bot's own Bots see.
import type { LocalService } from "@pibot/brain/kit";

/**
 * The Bot browser (its own profile; the user takes over logins and CAPTCHAs in the browser panel)
 * and send_file. Not offered: the browser's credential tools (browser_network, browser_request,
 * browser_secret, browser_login) hand out secret handles or saved passwords that only Pi Bot's own
 * command and request paths can consume; T2 decides connections, which carry the same concern.
 */
export const BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  "browser_open",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_scroll",
  "browser_back",
  "browser_wait",
  "browser_tabs",
  "browser_close",
  "browser_inspect",
  "browser_diagnostics",
  "browser_download_list",
  "connector_discover",
  "connector_call",
  "send_file",
  "skill_read",
]);

export interface BridgeToolListing {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

/**
 * The listing an agent caches for its whole session, so it does not depend on one turn: Pi Bot's
 * catalog filtered to the bridge set and to what this host can do. Whether a call may run is
 * decided per call by the turn's own tool gate (Bot levels, images, policy, approvals).
 */
export function bridgeToolListing(local: LocalService): BridgeToolListing[] {
  const browser = !!local.deps.host.browser;
  return local.toolDefinitions
    .filter((tool) => BRIDGE_TOOLS.has(tool.name))
    .filter((tool) => browser || !tool.name.startsWith("browser_"))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.parameters, type: "object" as const },
    }));
}
