import type {
  BrowserPlatform,
  Session as HostSession,
  BrowserWindow as HostWindow,
} from "@pibot/browser/host";
import {
  checkedUrl,
  checkProxyTarget,
  isPublicAddress,
  publicAddresses,
} from "@pibot/execution/web-address";
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  nativeImage,
  session,
} from "electron";
import {
  bringToFront,
  drawsOnlyWhenShown,
  prepareTabWindow,
  redrawHidden,
  sendToBack,
  takeoverBounds,
} from "./window-present.ts";
/** Only desktop constructs Electron objects; the host capability receives an instance-owned port. */
export function browserPlatform(): BrowserPlatform {
  // Recursive window/session types are narrowed here; the values remain native Electron objects.
  return {
    app,
    sessionFromPath: (path) => session.fromPath(path) as unknown as HostSession,
    createWindow: (options) =>
      new BrowserWindow(
        options as unknown as BrowserWindowConstructorOptions,
      ) as unknown as HostWindow,
    prepareTabWindow: (window) => prepareTabWindow(window as BrowserWindow),
    bringToFront: (window) => bringToFront(window as BrowserWindow),
    sendToBack: (window) => sendToBack(window as BrowserWindow),
    takeoverBounds,
    drawsOnlyWhenShown,
    redrawHidden: (window, options) => redrawHidden(window as BrowserWindow, options),
    htmlText: async (html, options) => {
      // Off this process's main thread: it also serves the brain and the window (maintainers 2026-11-18).
      const { htmlTextInWorker } = await import("@pibot/execution/html-text");
      return htmlTextInWorker(html, options);
    },
    thumbnail: (data, width, quality) => {
      const image = nativeImage.createFromBuffer(data);
      if (image.isEmpty()) return undefined;
      const fitted =
        image.getSize().width > width ? image.resize({ width, quality: "good" }) : image;
      return fitted.toJPEG(quality);
    },
    address: { checkedUrl, checkProxyTarget, publicAddresses, isPublicAddress },
  };
}
