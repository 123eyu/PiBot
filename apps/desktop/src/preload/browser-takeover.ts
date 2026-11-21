import {
  type LoginFillResult,
  TakeoverToolbarMethods,
  type TakeoverToolbarState,
} from "@pibot/protocol";
import { contextBridge, ipcRenderer } from "electron";

const CHANNEL = "pibot:takeover-toolbar";
type Fill = { credentialId: string; tab: string; documentId: string };
async function call(method: keyof typeof TakeoverToolbarMethods, params?: Fill) {
  const schema = TakeoverToolbarMethods[method];
  const checked = schema.params.parse(params);
  // Host calls have their own AbortSignal; this bound also handles a dying owner process.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      ipcRenderer.invoke(CHANNEL, { method, params: checked }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("takeover_toolbar_timeout")), 30_000);
      }),
    ]);
    if (!reply?.ok) throw new Error("takeover_toolbar_unavailable");
    return schema.result.parse(reply.result);
  } finally {
    clearTimeout(timer);
  }
}
contextBridge.exposeInMainWorld(
  "pibotTakeover",
  Object.freeze({
    getState: () => call("getState") as Promise<TakeoverToolbarState>,
    fill: (params: Fill) => call("fill", params) as Promise<LoginFillResult>,
    handBack: () => call("handBack") as Promise<{ ok: true }>,
    onChanged(callback: () => void) {
      const receive = () => callback();
      ipcRenderer.on(`${CHANNEL}:changed`, receive);
      return () => ipcRenderer.off(`${CHANNEL}:changed`, receive);
    },
  }),
);
