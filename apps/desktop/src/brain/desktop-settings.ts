import { randomUUID } from "node:crypto";
import { type Port, type Settings, SettingsSchema } from "@pibot/protocol";

export function desktopSettingsPort(port: Port, onSettings: (settings: Settings) => void) {
  const pending = new Set<string>();
  const receivers = new Set<(message: unknown) => void>();
  const request = (method: "settings.get" | "settings.set", params?: unknown) => {
    const id = randomUUID();
    pending.add(id);
    for (const receiver of receivers) receiver({ jsonrpc: "2.0", id, method, params });
  };
  const observed: Port = {
    post(message) {
      if (message && typeof message === "object") {
        const response = message as {
          id?: unknown;
          method?: unknown;
          result?: unknown;
          params?: { payload?: unknown };
        };
        const internal = typeof response.id === "string" && pending.delete(response.id);
        const candidate =
          response.method === "settings.changed"
            ? response.params?.payload
            : internal
              ? response.result
              : undefined;
        const settings = SettingsSchema.safeParse(candidate);
        if (settings.success) onSettings(settings.data);
        if (internal) return;
      }
      port.post(message);
    },
    onMessage(receiver) {
      receivers.add(receiver);
      const unsubscribe = port.onMessage(receiver);
      return () => {
        receivers.delete(receiver);
        unsubscribe();
      };
    },
  };
  return {
    port: observed,
    read: () => request("settings.get"),
    markCloseHint: () => request("settings.set", { closeToTrayHintShown: true }),
    syncLoginItem: (openAtLogin: boolean) => request("settings.set", { openAtLogin }),
  };
}
