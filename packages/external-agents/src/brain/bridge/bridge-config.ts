// The `pibot` entry of an agent session's ACP `mcpServers`: the relay script on Pi Bot's
// helper Node, told where the brain listens and given the session's token in its environment
// (never on the command line, where other processes could read it).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { childNodeRuntime, unpackedPath } from "@pibot/execution";
import type { BridgeAddress } from "./bridge-server.ts";

/**
 * The relay next to the bundle in the desktop build (electron-vite entry `pibot-mcp-bridge`,
 * unpacked for the helper Node), or the TypeScript source when the brain runs from the workspace.
 */
function relayScript() {
  const bundled = new URL("./pibot-mcp-bridge.js", import.meta.url);
  if (existsSync(bundled)) return unpackedPath(fileURLToPath(bundled));
  const source = fileURLToPath(new URL("../../bridge/pibot-mcp-bridge.ts", import.meta.url));
  return existsSync(source) ? source : undefined;
}

/** The helper Node and the relay script the agent starts; undefined in a broken package. */
export function relayProgram(): { node: string; script: string } | undefined {
  const script = relayScript();
  if (!script) return undefined;
  try {
    return { node: childNodeRuntime().executable, script };
  } catch {
    // No helper Node (a broken package): the agent runs without Pi Bot's tools, as before the
    // bridge existed.
    return undefined;
  }
}

export function pibotMcpServer(address: BridgeAddress, token: string) {
  const program = relayProgram();
  if (!program) return undefined;
  const { node, script } = program;
  return {
    name: "pibot",
    command: node,
    args: [script],
    env: [
      { name: "PIBOT_BRIDGE_TOKEN", value: token },
      address.kind === "unix"
        ? { name: "PIBOT_BRIDGE_SOCKET", value: address.path }
        : { name: "PIBOT_BRIDGE_PORT", value: String(address.port) },
    ],
  };
}
