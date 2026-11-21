// Where Pi Bot's MCP bridge socket lives on macOS. Beside the sandbox hosts'
// sockets (SANDBOX_HOST_DIR): every sandbox may write only its own private folder in there, so no
// sandboxed code can create, remove or replace a name next to it; the agent sandbox additionally
// denies writes to the socket name itself (external-agent-sandbox.ts).
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_HOST_DIR } from "../sandbox/sandbox-config.ts";

/** macOS sun_path is 104 bytes including the terminator. */
const SOCKET_PATH_LIMIT = 103;
const NAME = "pibot-mcp.sock";

/** A fresh 0700 folder for the bridge socket and the socket path inside it. */
export async function agentBridgeSocketPath(tempDir: string) {
  const parent = join(await realpath(tempDir), SANDBOX_HOST_DIR);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // mkdtemp adds six characters; the extra separator and prefix make eight.
  const folder =
    parent.length + 8 + 1 + NAME.length <= SOCKET_PATH_LIMIT
      ? await mkdtemp(join(parent, "b"))
      : // A temp dir too long for socket paths: a random 0700 folder in /tmp, as sandbox hosts do.
        await mkdtemp(join(await realpath("/tmp"), "pibot-srt-"));
  return { folder, path: join(folder, NAME) };
}
