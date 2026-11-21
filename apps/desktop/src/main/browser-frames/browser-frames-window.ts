import type { BrowserFrameTransport } from "@pibot/browser/host";
import {
  BROWSER_FRAME_CHANNEL,
  BrowserFrameAckSchema,
  type BrowserFrameMessage,
  browserProfileKey,
} from "@pibot/protocol";
import { type BrowserWindow, MessageChannelMain, type MessagePortMain } from "electron";

/**
 * Last hop of the overlay frame channel: one MessagePort per Bot into the window's renderer,
 * separate from the business port. Used by the window's own main process on every platform
 * (Windows / Linux next to the host, macOS in the GUI main relaying the owner's frames).
 */
export function createWindowFramePorts(window: BrowserWindow) {
  const ports = new Map<string, MessagePortMain>();
  const listeners = new Set<(botId: string, seq: number, groupId?: string) => void>();
  const close = (botId: string) => {
    const port = ports.get(botId);
    ports.delete(botId);
    port?.close();
  };
  const reset = () => {
    for (const botId of [...ports.keys()]) close(botId);
  };
  const open = (botId: string, groupId?: string) => {
    const key = browserProfileKey(botId, groupId);
    const existing = ports.get(key);
    if (existing) return existing;
    if (window.isDestroyed()) return undefined;
    const channel = new MessageChannelMain();
    const port = channel.port1;
    ports.set(key, port);
    port.on("message", (event: { data: unknown }) => {
      const ack = BrowserFrameAckSchema.safeParse(event.data);
      if (ack.success && ack.data.groupId === groupId && ports.get(key) === port)
        for (const listener of listeners) listener(botId, ack.data.seq, groupId);
    });
    port.once("close", () => {
      if (ports.get(key) === port) ports.delete(key);
    });
    port.start();
    window.webContents.postMessage(
      BROWSER_FRAME_CHANNEL,
      { botId, ...(groupId ? { groupId } : {}) },
      [channel.port2],
    );
    return port;
  };
  // A reloaded document lost its ports; the next frame opens a fresh one. Only a committed
  // main-frame navigation counts: a refused location.reload() keeps the live document.
  const navigation = () => reset();
  window.webContents.on("did-navigate", navigation);
  const transport: BrowserFrameTransport & { reset(): void; dispose(): void } = {
    send(message: BrowserFrameMessage) {
      const key = browserProfileKey(message.botId, message.groupId);
      if (message.type === "end") {
        const port = ports.get(key);
        try {
          port?.postMessage(message);
        } catch {
          // The renderer side is already gone; closing below is all that is left to do.
        }
        close(key);
        return true;
      }
      const port = open(message.botId, message.groupId);
      if (!port) return false;
      try {
        port.postMessage(message);
        return true;
      } catch {
        close(key);
        return false;
      }
    },
    onAck(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset,
    dispose() {
      reset();
      listeners.clear();
      if (!window.isDestroyed()) window.webContents.off("did-navigate", navigation);
    },
  };
  return transport;
}
