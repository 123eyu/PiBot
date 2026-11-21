// Explicit synthetic Electron surface for the private Node call-chain exercise, not an OS test.
import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";

class PortMain {
  constructor(readonly node: MessagePort) {}
  private listeners = new Map<(...args: never[]) => void, (data: unknown) => void>();
  on(_name: string, listener: (event: { data: unknown }) => void) {
    const wrapped = (data: unknown) => listener({ data });
    this.listeners.set(listener as (...args: never[]) => void, wrapped);
    this.node.on("message", wrapped);
    return this;
  }
  off(_name: string, listener: (...args: never[]) => void) {
    const wrapped = this.listeners.get(listener);
    if (wrapped) this.node.off("message", wrapped);
    this.listeners.delete(listener);
    return this;
  }
  start() {
    this.node.start();
  }
  close() {
    this.node.close();
  }
  postMessage(value: unknown) {
    this.node.postMessage(value);
  }
}
export class MessageChannelMain {
  readonly port1: PortMain;
  readonly port2: PortMain;
  constructor() {
    const channel = new MessageChannel();
    this.port1 = new PortMain(channel.port1);
    this.port2 = new PortMain(channel.port2);
  }
}
export const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  getLocale: () => "en",
  getAppPath: () => "synthetic-app-never-launched",
  quit: () => {
    let prevented = false;
    app.emit("before-quit", {
      preventDefault() {
        prevented = true;
      },
    });
    if (!prevented) process.exit(0);
  },
});
export const handlers = new Map<string, (...args: unknown[]) => unknown>();
export const ipcMain = Object.assign(new EventEmitter(), {
  handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  removeHandler: (name: string) => handlers.delete(name),
});
export const nativeTheme = Object.assign(new EventEmitter(), {
  shouldUseDarkColors: false,
  themeSource: "system",
});
export const screen = {
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }],
};
export const shell = {
  openExternal: async () => {},
  openPath: async () => "",
  showItemInFolder() {},
};
export const dialog = {
  showSaveDialog: async () => ({ canceled: true }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};
export const Notification = { isSupported: () => false };
export class Tray {}
export const Menu = {};
export const nativeImage = {};
export class BrowserWindow extends EventEmitter {
  static latest: BrowserWindow;
  private destroyed = false;
  renderer?: MessagePort;
  readonly webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    send: () => {},
    setWindowOpenHandler: () => {},
    postMessage: (_name: string, _value: unknown, ports: PortMain[]) => {
      this.renderer?.close();
      this.renderer = ports[0]?.node;
      this.emit("renderer-port", this.renderer);
    },
  });
  constructor(_options: unknown) {
    super();
    BrowserWindow.latest = this;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  show() {}
  focus() {
    this.emit("focus");
  }
  hide() {}
  setBackgroundColor() {}
  setTitleBarOverlay() {}
  getNormalBounds() {
    return { width: 1280, height: 800 };
  }
  destroy() {
    this.destroyed = true;
    this.renderer?.close();
    this.emit("closed");
  }
  async loadFile() {
    ipcMain.emit("pibot:renderer-ready", {
      sender: this.webContents,
      senderFrame: this.webContents.mainFrame,
    });
  }
  async loadURL() {
    return this.loadFile();
  }
}
