import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  type MessagePortMain,
  session,
} from "electron";
import {
  BRIDGE_PEERS,
  BRIDGE_REQUESTS,
  BRIDGE_TIMEOUT,
  type BridgeCommand,
  BridgeCommandSchema,
  BridgeEventSchema,
} from "../../link-bridge/protocol.ts";
import { linkBridgeArguments, secureLinkWindow } from "./security.ts";

const IDLE_MS = 5 * 60_000;

/** Main owns the stable utility port; renderer capabilities are renewed with each window. */
export function createLinkBridge(options: {
  port: MessagePortMain;
  outputDir: string;
  devUrl?: string;
}) {
  const peers = new Set<string>();
  const closing = new Map<string, ReturnType<typeof setTimeout>>();
  let pending: BridgeCommand[] = [];
  let window: BrowserWindow | undefined;
  let rendererPort: MessagePortMain | undefined;
  let removeReady: (() => void) | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let disposed = false;
  let isolatedSession: Electron.Session | undefined;

  const post = (value: unknown) => {
    if (disposed) return;
    try {
      options.port.postMessage(value);
    } catch {
      disposed = true;
      retireWindow(false);
      options.port.off("message", receive);
      options.port.off("close", dispose);
      options.port.close();
    }
  };
  const retireWindow = (failed: boolean) => {
    const oldWindow = window;
    window = undefined;
    ready = false;
    clearTimeout(loadTimer);
    clearTimeout(idleTimer);
    for (const timer of closing.values()) clearTimeout(timer);
    closing.clear();
    removeReady?.();
    removeReady = undefined;
    rendererPort?.removeAllListeners();
    rendererPort?.close();
    rendererPort = undefined;
    pending = [];
    for (const peer of peers) post({ kind: "closed", peer, failed });
    peers.clear();
    if (oldWindow && !oldWindow.isDestroyed()) oldWindow.destroy();
  };
  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (peers.size === 0) idleTimer = setTimeout(() => retireWindow(false), IDLE_MS);
  };
  const ensureWindow = () => {
    if (window) return;
    const channel = `pibot:link-bridge-${randomUUID()}`;
    const root = join(options.outputDir, "..", "renderer");
    isolatedSession ??= session.fromPartition(`link-bridge-${randomUUID()}`);
    const created = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        session: isolatedSession,
        preload: join(options.outputDir, "..", "preload", "link-bridge.cjs"),
        additionalArguments: linkBridgeArguments(
          channel,
          app.commandLine.getSwitchValue("disable-features"),
        ),
      },
    });
    window = created;
    secureLinkWindow(created, root, options.devUrl);
    const bridge = new MessageChannelMain();
    rendererPort = bridge.port1;
    bridge.port1.on("message", (event) => {
      if (window !== created) return;
      const parsed = BridgeEventSchema.safeParse(event.data);
      if (!parsed.success) return retireWindow(true);
      if (!peers.has(parsed.data.peer)) return;
      post(parsed.data);
      if (parsed.data.kind === "closed" || (parsed.data.kind === "result" && !parsed.data.ok)) {
        clearTimeout(closing.get(parsed.data.peer));
        closing.delete(parsed.data.peer);
        peers.delete(parsed.data.peer);
        scheduleIdle();
      }
    });
    bridge.port1.on("close", () => {
      if (window === created) retireWindow(true);
    });
    bridge.port1.start();
    let delivered = false;
    const onReady = (event: Electron.IpcMainEvent) => {
      if (
        window !== created ||
        delivered ||
        event.sender !== created.webContents ||
        event.senderFrame !== created.webContents.mainFrame
      )
        return;
      try {
        created.webContents.postMessage(channel, null, [bridge.port2]);
        delivered = true;
        ready = true;
        clearTimeout(loadTimer);
        removeReady?.();
        removeReady = undefined;
        for (const message of pending) bridge.port1.postMessage(message);
        pending = [];
        scheduleIdle();
      } catch {
        retireWindow(true);
      }
    };
    ipcMain.on(`${channel}:ready`, onReady);
    removeReady = () => {
      ipcMain.off(`${channel}:ready`, onReady);
      if (!delivered) bridge.port2.close();
    };
    created.on("closed", () => {
      if (window === created) retireWindow(true);
    });
    created.webContents.on("render-process-gone", () => {
      if (window === created) retireWindow(true);
    });
    loadTimer = setTimeout(() => retireWindow(true), BRIDGE_TIMEOUT);
    const loading = options.devUrl
      ? created.loadURL(new URL("/link-bridge/index.html", options.devUrl).href)
      : created.loadFile(join(root, "link-bridge", "index.html"));
    void loading.catch(() => {
      if (window === created) retireWindow(true);
    });
  };
  const receive = (event: { data: unknown }) => {
    if (disposed) return;
    const parsed = BridgeCommandSchema.safeParse(event.data);
    if (!parsed.success) return retireWindow(true);
    const value = parsed.data;
    if (value.kind === "request" && value.operation.type === "create") {
      if (peers.has(value.peer) || peers.size >= BRIDGE_PEERS) {
        post({ kind: "result", peer: value.peer, id: value.id, ok: false });
        return;
      }
      peers.add(value.peer);
      clearTimeout(idleTimer);
    } else if (!peers.has(value.peer)) return;
    if (closing.has(value.peer)) return;
    if (value.kind === "close" && !ready) {
      peers.delete(value.peer);
      pending = pending.filter((message) => message.peer !== value.peer);
      post({ kind: "closed", peer: value.peer, failed: false });
      scheduleIdle();
      return;
    }
    try {
      ensureWindow();
      if (ready) {
        rendererPort?.postMessage(value);
        if (value.kind === "close")
          closing.set(
            value.peer,
            setTimeout(() => retireWindow(true), BRIDGE_TIMEOUT),
          );
      } else {
        if (pending.length >= BRIDGE_REQUESTS) return retireWindow(true);
        pending.push(value);
      }
    } catch {
      retireWindow(true);
    }
  };
  const dispose = () => {
    if (disposed) return;
    retireWindow(false);
    disposed = true;
    options.port.off("message", receive);
    options.port.off("close", dispose);
    options.port.close();
  };
  options.port.on("message", receive);
  options.port.on("close", dispose);
  options.port.start();
  return { dispose };
}
