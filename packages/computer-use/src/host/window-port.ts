/** Only Electron chrome primitives; the capability never imports Electron or gains a business port. */
export interface GuardIpcEvent {
  sender: unknown;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface GuardNativeWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  webContents: {
    send(channel: string, data: unknown): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): unknown;
  };
  setAlwaysOnTop(flag: boolean, level: "screen-saver"): void;
  setVisibleOnAllWorkspaces(
    flag: boolean,
    options: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean },
  ): void;
  on(event: "closed", listener: () => void): unknown;
  once(event: "ready-to-show", listener: () => void): unknown;
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  setBounds(bounds: Rect): void;
  hide(): void;
  destroy(): void;
}
export interface GuardWindowOptions extends Rect {
  show: boolean;
  frame: boolean;
  transparent: boolean;
  resizable: boolean;
  minimizable: boolean;
  maximizable: boolean;
  fullscreenable: boolean;
  skipTaskbar: boolean;
  focusable: boolean;
  alwaysOnTop: boolean;
  hasShadow: boolean;
  title: string;
  type?: "panel";
  webPreferences: {
    preload: string;
    partition: string;
    sandbox: boolean;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    spellcheck: boolean;
    backgroundThrottling: boolean;
  };
}
export interface GuardElectron {
  createWindow(options: GuardWindowOptions): GuardNativeWindow;
  denyPermissions(partition: string): void;
  ipcMain: {
    on(channel: string, listener: (event: GuardIpcEvent, raw: unknown) => void): unknown;
    off(channel: string, listener: (event: GuardIpcEvent, raw: unknown) => void): unknown;
  };
  nativeTheme: {
    shouldUseDarkColors: boolean;
    on(event: "updated", listener: () => void): unknown;
    off(event: "updated", listener: () => void): unknown;
  };
  screen: { getPrimaryDisplay(): { workArea: Rect } };
}
