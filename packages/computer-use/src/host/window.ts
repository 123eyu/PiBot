import { join } from "node:path";
import tokens from "@pibot/ui/tokens.css?raw";
import type { GuardRenderState } from "./types.ts";
import type { GuardElectron, GuardIpcEvent, GuardNativeWindow } from "./window-port.ts";

const WIDTH = 560;
const ROW_HEIGHT = 52;
const PARTITION = "pibot-guard";

// Colours come only from the shared theme tokens; the bar inverts the page colours
// (dark bar in light mode), and a paused bar uses the warning token.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>${tokens}
html,body{margin:0;background:transparent;overflow:hidden;font-family:var(--font-sans);user-select:none}
#rows{display:flex;flex-direction:column;gap:8px;padding:4px 8px}
.bar{display:flex;align-items:center;gap:10px;height:44px;padding:0 8px 0 14px;border-radius:var(--radius-pill);
  background:var(--prim);color:var(--bg);box-shadow:var(--shadow);font-size:13px}
.bar.paused{background:var(--warn)}
.bar.confirm{background:var(--card);color:var(--text);border:1px solid var(--hover)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--dot,var(--avatar-pink));flex:none}
.bar.background .dot,.bar.foreground .dot{animation:pulse 1.2s ease-in-out infinite}
.bar.paused .dot,.bar.waiting .dot{background:var(--bg);animation:none}
.text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{height:30px;padding:0 12px;border:0;border-radius:15px;font:inherit;font-size:12.5px;cursor:pointer;
  background:color-mix(in srgb,var(--bg) 18%,transparent);color:inherit}
.btn.primary{background:var(--bg);color:var(--prim);font-weight:600}
.bar.confirm .btn{background:var(--hover)}
.bar.confirm .btn.primary{background:var(--prim);color:var(--bg)}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot{animation:none!important}}
</style></head><body><div id="rows" role="status" aria-live="polite"></div></body></html>`;

/**
 * The indicator window: always on top, never takes focus, on every desktop space,
 * independent of the desktop window so it also shows when only the background process runs.
 * Owner: the computer guard; `destroy()` closes the window and removes the IPC listeners.
 */
export function createGuardWindow(options: {
  electron: GuardElectron;
  outputDir: string;
  title: string;
  onAction(raw: unknown): void;
}) {
  const { ipcMain, nativeTheme, screen } = options.electron;
  let window: GuardNativeWindow | undefined;
  let ready = false;
  let latest: GuardRenderState | undefined;
  options.electron.denyPermissions(PARTITION);
  const send = () => {
    if (!window || window.isDestroyed() || !ready || !latest) return;
    window.webContents.send("pibot-guard:state", {
      ...latest,
      theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    });
  };
  const fromWindow = (event: GuardIpcEvent) =>
    !!window && !window.isDestroyed() && event.sender === window.webContents;
  const onReady = (event: GuardIpcEvent) => {
    if (!fromWindow(event)) return;
    ready = true;
    send();
  };
  const onAction = (event: GuardIpcEvent, raw: unknown) => {
    if (fromWindow(event)) options.onAction(raw);
  };
  ipcMain.on("pibot-guard:ready", onReady);
  ipcMain.on("pibot-guard:action", onAction);
  nativeTheme.on("updated", send);

  const bounds = (rows: number) => {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(WIDTH, area.width - 16);
    return {
      width,
      height: Math.max(1, rows) * ROW_HEIGHT + 8,
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + 8,
    };
  };
  const create = (rows: number) => {
    const created = options.electron.createWindow({
      ...bounds(rows),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      title: options.title,
      // A non-activating panel on macOS: clicks work without pulling focus from the user's app.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: {
        preload: join(options.outputDir, "..", "preload", "computer-guard.cjs"),
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    created.setAlwaysOnTop(true, "screen-saver");
    // skipTransformProcessType keeps the dock-less background owner from becoming a regular app.
    created.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.on("closed", () => {
      if (window === created) {
        window = undefined;
        ready = false;
      }
    });
    void created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    created.once("ready-to-show", () => created.showInactive());
    return created;
  };

  return {
    show(state: GuardRenderState) {
      latest = state;
      const rows = state.rows.reduce((sum, row) => sum + (row.confirm ? 2 : 1), 0);
      if (!window || window.isDestroyed()) window = create(rows);
      else {
        window.setBounds(bounds(rows));
        if (!window.isVisible()) window.showInactive();
      }
      send();
    },
    hide() {
      latest = undefined;
      if (window && !window.isDestroyed()) window.hide();
    },
    destroy() {
      ipcMain.off("pibot-guard:ready", onReady);
      ipcMain.off("pibot-guard:action", onAction);
      nativeTheme.off("updated", send);
      if (window && !window.isDestroyed()) window.destroy();
      window = undefined;
    },
  };
}
