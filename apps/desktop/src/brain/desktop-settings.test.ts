import { createPeer, Events, Methods } from "@pibot/protocol";
import { DEFAULT_SETTINGS } from "@pibot/storage";
import { expect, it, vi } from "vitest";
import { memoryPorts } from "../test-port.ts";
import { desktopSettingsPort } from "./desktop-settings.ts";

it("syncs validated settings to main without sending internal RPC responses to renderer", async () => {
  const [a, b] = memoryPorts();
  const onSettings = vi.fn();
  const received: unknown[] = [];
  const observer = desktopSettingsPort(a, onSettings);
  const brain = createPeer(observer.port, { methods: Methods, events: Events });
  const unsubscribe = b.onMessage((message) => received.push(message));
  let settings = { ...DEFAULT_SETTINGS };
  brain.handle("settings.get", async () => settings);
  brain.handle("settings.set", async (patch) => {
    settings = { ...settings, ...patch };
    brain.emit("settings.changed", settings);
    return settings;
  });
  try {
    observer.read();
    await vi.waitFor(() => expect(onSettings).toHaveBeenCalledWith(settings));
    expect(received).toEqual([]);
    observer.markCloseHint();
    await vi.waitFor(() => expect(settings.closeToTrayHintShown).toBe(true));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "settings.changed" });
    const calls = onSettings.mock.calls.length;
    observer.port.post({
      method: "settings.changed",
      params: { payload: { OPENAI_API_KEY: "fake" } },
    });
    expect(onSettings.mock.calls).toHaveLength(calls);
  } finally {
    unsubscribe();
    brain.dispose();
  }
});
