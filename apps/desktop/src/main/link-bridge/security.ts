import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";

/** The process-wide FeatureList is configured by the main entry before ready. */
export function linkBridgeArguments(channel: string, _disabledFeatures = "") {
  return [`--link-bridge-channel=${channel}`];
}

export function secureLinkWindow(window: BrowserWindow, root: string, devUrl?: string) {
  window.webContents.setWebRTCIPHandlingPolicy("default");
  const origin = devUrl ? new URL(devUrl).origin : undefined;
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) =>
    reply(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setDevicePermissionHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, reply) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      const path = url.protocol === "file:" ? relative(resolve(root), fileURLToPath(url)) : "";
      const local =
        url.protocol === "file:" &&
        !isAbsolute(path) &&
        path !== ".." &&
        !path.startsWith(`..${sep}`);
      allowed =
        local && (path === `link-bridge${sep}index.html` || path.startsWith(`assets${sep}`));
      if (origin && url.origin === origin)
        allowed =
          details.resourceType === "script" ||
          (details.resourceType === "mainFrame" && url.pathname === "/link-bridge/index.html");
    } catch {
      // Malformed requests have no authority to leave the bridge.
    }
    reply({ cancel: !allowed });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
