import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "@pibot/storage/data-dir";
import { ExtensionEndpointSchema, extensionEndpointFile } from "./extension-server.ts";
import { readNativeMessages, writeNativeMessage } from "./native-messaging.ts";

/**
 * The process a browser starts for the extension (through the launcher, which sets
 * PIBOT_DATA_DIR). It relays the browser's framed messages to the running Pi Bot's extension
 * endpoint and back; it reads no message itself and logs nothing about them.
 */
export async function startBrowserNativeEntry(options: {
  env: Readonly<NodeJS.ProcessEnv>;
  dev: boolean;
}): Promise<number> {
  const dataDir = resolveDataDir({
    platform: process.platform,
    env: options.env,
    homedir: homedir(),
    dev: options.dev,
  });
  // Pi Bot is not running (or too old to have the endpoint): the extension sees a disconnect.
  const { endpoint, token } = ExtensionEndpointSchema.parse(
    JSON.parse(await readFile(extensionEndpointFile(join(dataDir, "background-runtime")), "utf8")),
  );
  const tcp = /^tcp:127\.0\.0\.1:(\d{1,5})$/.exec(endpoint);
  const socket: Socket = tcp
    ? createConnection({ host: "127.0.0.1", port: Number(tcp[1]) })
    : createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`${JSON.stringify({ auth: token })}\n`);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      void writeNativeMessage(process.stdout, JSON.parse(line)).catch(() => socket.destroy());
    }
  });
  const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  try {
    const reading = (async () => {
      for await (const message of readNativeMessages(process.stdin))
        socket.write(`${JSON.stringify(message)}\n`);
    })();
    // The browser closing stdin, or Pi Bot closing the socket, ends the host.
    await Promise.race([reading, ended]);
    return 0;
  } catch {
    return 1;
  } finally {
    socket.destroy();
  }
}
