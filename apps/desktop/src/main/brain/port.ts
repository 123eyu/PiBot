import type { Port } from "@pibot/protocol";
import type { MessagePortMain } from "electron";

export function mainPort(port: MessagePortMain): Port {
  return {
    post: (message) => port.postMessage(message),
    onMessage(listener) {
      const receive = (event: { data: unknown }) => listener(event.data);
      port.on("message", receive);
      port.start();
      return () => port.off("message", receive);
    },
  };
}
