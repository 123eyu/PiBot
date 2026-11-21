import type { Logger } from "@pibot/observability";
import {
  DESKTOP_RESTART_CHANNEL,
  DesktopRestartRequestSchema,
  DesktopRestartResultSchema,
} from "@pibot/protocol";
import { type BrowserWindow, ipcMain } from "electron";

/** Acknowledge before normal quit retires the window and its authenticated owner connection. */
export function registerAppRestart(options: {
  window: BrowserWindow;
  logger: Logger;
  restart(): void;
}) {
  let pending: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  ipcMain.handle(DESKTOP_RESTART_CHANNEL, (event, input: unknown) => {
    if (
      closed ||
      event.sender !== options.window.webContents ||
      event.senderFrame !== options.window.webContents.mainFrame ||
      !DesktopRestartRequestSchema.safeParse(input).success
    )
      return { ok: false };
    if (!pending) {
      options.logger.info(
        JSON.stringify({ module: "app", event: "restart_requested", actor: "user" }),
      );
      pending = setTimeout(() => {
        pending = undefined;
        if (!closed) options.restart();
      }, 0);
    }
    return { ok: true, result: DesktopRestartResultSchema.parse({ status: "requested" }) };
  });
  options.window.once("closed", () => {
    closed = true;
    clearTimeout(pending);
    ipcMain.removeHandler(DESKTOP_RESTART_CHANNEL);
  });
}
