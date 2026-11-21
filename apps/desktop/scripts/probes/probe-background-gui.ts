// A self-created GUI main role with synthetic native surfaces and real MessagePorts/socket/PID.

import type { MessagePort } from "node:worker_threads";
import type { Logger } from "@pibot/observability";
import { createPeer, Methods, type Port, RpcError } from "@pibot/protocol";
import { connectBackground } from "../../src/main/background/background-connection.ts";
import { startGuiClient } from "../../src/main/gui/gui-client.ts";
import { app, BrowserWindow, ipcMain } from "./probe-background-electron.ts";

if (process.argv[3] === "detach-only") {
  const connection = await connectBackground(
    process.argv[2] as string,
    "synthetic-v1",
    () => {},
    () => {},
  );
  await connection.control({ type: "attach" });
  await connection.control({ type: "detach" });
  process.on("SIGTERM", () => {
    connection.close();
    process.exit(0);
  });
  process.send?.({ detached: true });
} else {
  let renderer: ReturnType<typeof createPeer<typeof Methods, Record<string, never>>> | undefined;
  let portCount = 0;
  const bind = (node: MessagePort) => {
    renderer?.dispose();
    const port: Port = {
      post: (message) => node.postMessage(message),
      onMessage: (listener) => {
        node.on("message", listener);
        return () => node.off("message", listener);
      },
    };
    renderer = createPeer(port, { methods: Methods, events: {} });
    portCount++;
  };
  const logger = {
    info() {},
    warn(message: string) {
      process.send?.({ warning: message });
    },
    error(message: string) {
      process.send?.({ error: message });
    },
  } as Logger;
  await startGuiClient({
    dataDir: process.argv[2] as string,
    version: "synthetic-v1",
    outputDir: "/private/tmp/unused",
    dev: true,
    originalEnv: {},
    logger,
  });
  const window = BrowserWindow.latest;
  if (window.renderer) bind(window.renderer);
  window.on("renderer-port", bind);
  process.on("SIGTERM", () => app.quit());
  process.on("message", async (value: { command: string }) => {
    try {
      if (value.command === "quit") app.quit();
      else if (value.command === "reload") {
        window.webContents.emit("did-start-navigation", {}, "", false, true);
        ipcMain.emit("pibot:renderer-ready", {
          sender: window.webContents,
          senderFrame: window.webContents.mainFrame,
        });
        process.send?.({ reloaded: portCount });
      } else if (value.command === "rpc") {
        const result = await renderer?.call("settings.get", undefined, { timeoutMs: 2000 });
        process.send?.({ result, portCount });
      } else if (value.command === "burst") {
        const current = renderer;
        if (!current) throw new Error("synthetic renderer unavailable");
        const results = await Promise.all(
          Array.from({ length: 17 }, async (_, index) => {
            try {
              await current.call("settings.get", undefined, { timeoutMs: 2000 });
              return { ok: true };
            } catch (error) {
              const result = { ok: false, code: error instanceof RpcError ? error.code : null };
              if (index === 16) process.send?.({ overflow: result });
              return result;
            }
          }),
        );
        process.send?.({ burst: results, portCount });
      }
    } catch {
      process.send?.({ failed: value.command });
    }
  });
  process.send?.({ ready: true });
}
