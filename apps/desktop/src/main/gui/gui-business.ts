import { randomUUID } from "node:crypto";
import { type BackgroundState, type BackgroundWire, EventBuffer, Events } from "@pibot/protocol";
import { type BrowserWindow, MessageChannelMain, type MessagePortMain } from "electron";
import { createGuiRequestQueue } from "./gui-request-queue.ts";

// Each document gets a namespace. A late response can never become a new document's response.
export function createGuiBusiness(options: {
  window: BrowserWindow;
  send(message: BackgroundWire): void;
  status(): BackgroundState["state"];
  ready(): void;
  failed(): void;
}) {
  let port: MessagePortMain | undefined;
  let document = randomUUID(),
    waiting = false;
  const statuses = new EventBuffer(Events);
  const requests = createGuiRequestQueue({
    send: (message) => options.send({ kind: "business", message }),
    reply(current, message) {
      if (current !== document || !port) return;
      try {
        port.postMessage(message);
      } catch {
        // A retired document cannot receive replies; keep the connection's other slots intact.
        options.failed();
      }
    },
    failed: options.failed,
  });
  const reset = () => {
    requests.retire(document);
    port?.close();
    port = undefined;
    document = randomUUID();
  };
  const publishStatus = () => {
    // Transport absence is not a brain.status enum value. Preserve the established
    // renderer event contract while the authenticated owner state remains authoritative.
    const state = options.status();
    if (waiting && !options.window.isDestroyed())
      options.window.webContents.send(
        "pibot:status",
        statuses.append("brain.status", { state: state === "stopped" ? "starting" : state }),
      );
  };
  const ready = () => {
    waiting = true;
    reset();
    if (options.status() !== "ready") {
      publishStatus();
      return;
    }
    const channel = new MessageChannelMain();
    port = channel.port1;
    const current = document;
    channel.port1.on("message", (event: { data: unknown }) => {
      if (current !== document) return;
      requests.receive(current, event.data);
    });
    channel.port1.once("close", () => {
      requests.retire(current);
      if (current === document) port = undefined;
    });
    channel.port1.start();
    options.window.webContents.postMessage("pibot:port", { scheduled: true }, [channel.port2]);
    publishStatus();
    options.ready();
  };
  return {
    available: () => !!port && waiting && options.status() === "ready",
    ready,
    statusChanged() {
      if (options.status() === "ready" && waiting) ready();
      else {
        reset();
        publishStatus();
      }
    },
    receive(value: unknown) {
      // Responses from retired documents still release real server slots.
      if (value && typeof value === "object" && "id" in value) {
        requests.response(value);
      } else if (port && waiting) port.postMessage(value);
    },
    disconnected() {
      requests.disconnected();
    },
    reloading() {
      waiting = false;
      reset();
    },
    dispose() {
      waiting = false;
      reset();
      requests.dispose();
    },
  };
}
