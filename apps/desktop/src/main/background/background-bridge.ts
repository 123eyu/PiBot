import {
  DesktopBackgroundMethods,
  IndependentBackgroundMethods,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { BrowserWindow, IpcMain } from "electron";
import { z } from "zod";

const RequestSchema = z.strictObject({ method: z.string(), params: z.unknown().optional() });

export function registerBackgroundBridge(
  ipc: IpcMain,
  window: BrowserWindow,
  host: {
    backgroundState(): unknown;
    requestRestart(): () => void;
  },
  independentUnsupported = false,
) {
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  ipc.handle("pibot:background", async (event, input: unknown) => {
    try {
      if (
        closed ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new RpcError(RpcErrorCodes.closed, "background_bridge_closed");
      const request = RequestSchema.safeParse(input);
      if (!request.success)
        throw new RpcError(RpcErrorCodes.invalidParams, "invalid_background_request");
      const { method, params } = request.data;
      if (independentUnsupported && Object.hasOwn(IndependentBackgroundMethods, method)) {
        const schema =
          IndependentBackgroundMethods[method as keyof typeof IndependentBackgroundMethods];
        schema.params.parse(params);
        if (method !== "background.serviceState")
          throw new RpcError(RpcErrorCodes.unsupported, "background_windows_acl_unverified");
        return {
          ok: true,
          result: IndependentBackgroundMethods["background.serviceState"].result.parse({
            lifecycle: "unsupported",
            instance: null,
            startedAt: null,
            version: "embedded",
            preferences: { exitBehavior: "stop", startAtLogin: false },
            effectiveExitBehavior: "stop",
            clients: 0,
            management: {
              kind: "task-scheduler",
              available: false,
              registered: null,
              enabled: null,
              reason: "platform_unverified",
            },
          }),
        };
      }
      if (method !== "background.state" && method !== "background.restart")
        throw new RpcError(RpcErrorCodes.methodNotFound, "background_method_unavailable");
      const schema = DesktopBackgroundMethods[method];
      if (!schema.params.safeParse(params).success)
        throw new RpcError(RpcErrorCodes.invalidParams, "invalid_background_params");
      if (method === "background.state")
        return { ok: true, result: schema.result.parse(host.backgroundState()) };
      // The acknowledgement must be delivered before retiring the RPC's child.
      const restart = host.requestRestart();
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed) restart();
      }, 0);
      timers.add(timer);
      return {
        ok: true,
        result: DesktopBackgroundMethods["background.restart"].result.parse({
          status: "requested",
        }),
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof RpcError ? error.code : RpcErrorCodes.internal,
        message: error instanceof RpcError ? error.message : "background_request_failed",
      };
    }
  });
  return () => {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    ipc.removeHandler("pibot:background");
  };
}
