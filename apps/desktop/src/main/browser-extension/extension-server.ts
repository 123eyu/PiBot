import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { ExtensionHost } from "./extension-host.ts";

const MAX_LINE = 2 * 1024 * 1024;
const ENDPOINT_FILE = "browser-extension.json";
/** Where the native host finds us: written next to the owner's socket, readable by this user only. */
export const ExtensionEndpointSchema = z.strictObject({
  endpoint: z.string().min(1).max(512),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * The background end of the user's browser. The browser starts our native host, which
 * connects here (a Unix socket inside the data folder's 0700 runtime directory; loopback TCP on
 * Windows) and must present the token from the endpoint file first. One extension is served at a
 * time; a newer connection replaces the older one.
 */
export async function startExtensionServer(options: {
  dataDir: string;
  logger: { info(message: string): void; warn(message: string): void };
  onChange(): void;
  onStop(params: { botId: string; tab?: string }): void;
}) {
  const runtime = join(await realpath(options.dataDir), "background-runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const windows = process.platform === "win32";
  const socketPath = join(runtime, "browser.sock");
  if (!windows) await rm(socketPath, { force: true });
  let current: { socket: Socket; host: ExtensionHost } | undefined;
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    options.logger.info(JSON.stringify({ module: "browser-extension", event, ...extra }));

  const server: Server = createServer((socket) => {
    let authed = false;
    let buffer = "";
    let host: ExtensionHost | undefined;
    const send = (message: unknown) =>
      new Promise<void>((resolve, reject) =>
        socket.write(`${JSON.stringify(message)}\n`, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    const authTimer = setTimeout(() => socket.destroy(), 5_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        log("frame_too_large");
        socket.destroy();
        return;
      }
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.destroy();
          return;
        }
        if (!authed) {
          // Nothing is read before the token: a process that merely opened the endpoint can do
          // nothing (Windows loopback is reachable by any local process).
          const given = Buffer.from(String(message.auth ?? ""));
          const expected = Buffer.from(token);
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            log("auth_refused");
            socket.destroy();
            return;
          }
          authed = true;
          clearTimeout(authTimer);
          host = new ExtensionHost(send, options.onStop);
          if (current) {
            current.host.close();
            current.socket.destroy();
          }
          current = { socket, host };
          continue;
        }
        try {
          if (message.event === "hello") {
            host?.hello(message.payload);
            log("connected", { browser: host?.browser ?? "unknown" });
            options.onChange();
          } else if (message.event === "stop") host?.stop(message.payload);
          else if (typeof message.id === "string") host?.response(message);
        } catch {
          // A malformed frame from the extension fails only itself; the bridge stays up.
          log("frame_invalid");
        }
      }
    });
    const closed = () => {
      clearTimeout(authTimer);
      host?.close();
      if (current?.socket === socket) {
        current = undefined;
        log("disconnected");
        options.onChange();
      }
    };
    socket.on("close", closed);
    socket.on("error", () => socket.destroy());
  });

  const endpoint = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    if (windows)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? `tcp:127.0.0.1:${address.port}` : "");
      });
    else server.listen(socketPath, () => resolve(socketPath));
  });
  if (!windows) await chmod(socketPath, 0o600);
  const file = join(runtime, ENDPOINT_FILE);
  await writeFile(file, JSON.stringify({ endpoint, token }), { mode: 0o600 });
  return {
    /** The live extension, if one said hello. */
    get host() {
      return current?.host.connected ? current.host : undefined;
    },
    async close() {
      current?.host.close();
      current?.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(file, { force: true });
      if (!windows) await rm(socketPath, { force: true });
    },
  };
}

export const extensionEndpointFile = (runtime: string) => join(runtime, ENDPOINT_FILE);
