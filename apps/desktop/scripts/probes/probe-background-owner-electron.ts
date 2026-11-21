// Native surfaces are synthetic; each utility is an actual self-created Node process.
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";

export {
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  screen,
  shell,
} from "./probe-background-electron.ts";
export const ownerProbe = {
  scenario: "",
  spawn: 0,
  bootstrap: 0,
  utilityExit: 0,
  trayDestroy: 0,
  quit: 0,
};
export const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  hasSingleInstanceLock: () => true,
  getLocale: () => "en",
  getVersion: () => "synthetic-v1",
  getAppPath: () => "synthetic-app",
  getName: () => "Synthetic Pi Bot",
  quit: () => {
    let prevented = false;
    app.emit("before-quit", {
      preventDefault() {
        prevented = true;
      },
    });
    if (!prevented) {
      ownerProbe.quit++;
      process.send?.({ quit: { ...ownerProbe } });
      process.exit(0);
    }
  },
});
export const powerMonitor = Object.assign(new EventEmitter(), { isOnBatteryPower: () => false });
export const powerSaveBlocker = { start: () => 1, stop() {} };
export const Notification = { isSupported: () => false };
export const nativeImage = {
  createFromPath: () => ({ setTemplateImage() {}, toPNG: () => Buffer.alloc(0) }),
  createEmpty: () => ({ addRepresentation() {} }),
};
export const Menu = { buildFromTemplate: (rows: unknown) => rows };
export class Tray extends EventEmitter {
  private destroyed = false;
  setToolTip() {}
  setContextMenu() {}
  destroy() {
    if (this.destroyed) throw new Error("tray double release");
    this.destroyed = true;
    ownerProbe.trayDestroy++;
  }
}
export const session = {};
// Bundled code paths the owner probe never reaches (Bot browser, computer use); present so the
// bundle resolves, and denying so a regression that does reach them fails loudly.
export class View {}
export class WebContentsView extends View {}
export const systemPreferences = {
  getMediaAccessStatus: () => "denied",
  isTrustedAccessibilityClient: () => false,
  promptTouchID: async () => {
    throw new Error("private probe has no Touch ID");
  },
};
export const globalShortcut = { register: () => false, unregister() {} };
export const desktopCapturer = { getSources: async () => [] };
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("private probe never reads keys");
  },
  decryptString: () => {
    throw new Error("private probe never reads keys");
  },
};
export const utilityProcess = {
  fork: () => {
    const handle = new EventEmitter() as EventEmitter & {
      pid?: number;
      postMessage(value: unknown): void;
      kill(): void;
    };
    const child = fork(new URL("./probe-background-utility.mjs", import.meta.url), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    handle.pid = child.pid;
    ownerProbe.spawn++;
    process.send?.({ spawn: child.pid });
    child.once("spawn", () => handle.emit("spawn"));
    child.on("error", () => process.send?.({ nativeSurfaceClosed: true }));
    child.once("exit", (code) => {
      ownerProbe.utilityExit++;
      handle.pid = undefined;
      process.send?.({ utilityExit: child.pid });
      handle.emit("exit", code);
    });
    handle.kill = () => {
      child.kill("SIGTERM");
    };
    handle.postMessage = (value: unknown) => {
      const message = value as { type?: string; dataDir?: string; id?: string };
      if (message.dataDir) {
        ownerProbe.bootstrap++;
        process.send?.({ bootstrap: child.pid });
        if (ownerProbe.scenario !== "before-ready")
          setTimeout(() => handle.emit("message", { type: "ready" }), 5);
      } else if (message.type === "stop") {
        if (!child.connected) throw new Error("synthetic native IPC closed");
        child.send({ type: "stop" }, (error) => {
          if (error) process.send?.({ nativeSurfaceClosed: true });
        });
      }
      // No actual brain/DB/key is executed by this synthetic utility surface.
    };
    if (ownerProbe.scenario === "spawn-os-quit") app.quit();
    return handle;
  },
};
