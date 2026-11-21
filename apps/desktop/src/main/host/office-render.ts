import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HostMethods,
  type HostParams,
  type HostResults,
  OFFICE_RENDER_EDGE,
  OFFICE_RENDER_PAGE_BYTES,
  OFFICE_RENDER_PIXELS,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { BrowserWindow, ipcMain, session } from "electron";

type Input = HostParams["host.office.render"];
type Output = HostResults["host.office.render"];
const failed = () => new RpcError(RpcErrorCodes.internal, "office_render_failed");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validPng(page: Output[number]) {
  const bytes = Buffer.from(page.data, "base64");
  return (
    bytes.length >= 33 &&
    bytes.length <= OFFICE_RENDER_PAGE_BYTES &&
    bytes.subarray(0, 8).equals(png) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) === page.width &&
    bytes.readUInt32BE(20) === page.height
  );
}

export function createOfficeRenderHost(options: { outputDir: string; devUrl?: string }) {
  const root = resolve(options.outputDir, "..", "renderer");
  const devOrigin = options.devUrl ? new URL(options.devUrl).origin : undefined;
  const entry = devOrigin
    ? new URL("/office-render/index.html", devOrigin).href
    : pathToFileURL(join(root, "office-render", "index.html")).href;
  const partition = `office-render-${randomUUID()}`;
  let isolated: Electron.Session | undefined;
  const lifetime = new AbortController();
  let active: Promise<Output> | undefined;
  const denyDownload = (event: Electron.Event) => event.preventDefault();

  function allowed(raw: string) {
    try {
      const url = new URL(raw);
      if (url.protocol === "blob:") return url.origin === (devOrigin ?? "null");
      const path = devOrigin
        ? url.origin === devOrigin
          ? url.pathname.slice(1)
          : ""
        : url.protocol === "file:"
          ? relative(root, fileURLToPath(url)).replaceAll("\\", "/")
          : "";
      return (
        path === "office-render/index.html" ||
        /^ooxml\/(?:assets\/)?[\w.-]+\.(?:mjs|js|wasm)$/.test(path) ||
        (devOrigin
          ? path === "@vite/client" ||
            path === "@react-refresh" ||
            path === "office-render/render.ts"
          : /^assets\/(?:office-render|modulepreload-polyfill)-[\w-]+\.js$/.test(path))
      );
    } catch {
      return false;
    }
  }

  async function perform(params: Input, parent: AbortSignal): Promise<Output> {
    parent.throwIfAborted();
    const signal = AbortSignal.any([parent, AbortSignal.timeout(30_000)]);
    const channel = `office-render:${randomUUID()}`;
    let window: BrowserWindow | undefined;
    let cleanup: (() => void) | undefined;
    try {
      if (!isolated) {
        isolated = session.fromPartition(partition);
        isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
        isolated.setPermissionCheckHandler(() => false);
        isolated.on("will-download", denyDownload);
        isolated.webRequest.onBeforeRequest((details, reply) =>
          reply({ cancel: !allowed(details.url) }),
        );
      }
      const owner = new BrowserWindow({
        width: OFFICE_RENDER_EDGE,
        height: Math.floor(OFFICE_RENDER_PIXELS / 5 / OFFICE_RENDER_EDGE),
        show: false,
        webPreferences: {
          session: isolated,
          preload: join(options.outputDir, "..", "preload", "office-render.cjs"),
          additionalArguments: [`--office-render-channel=${channel}`],
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          offscreen: true,
          backgroundThrottling: false,
          devTools: false,
        },
      });
      window = owner;
      const contents = owner.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event) => event.preventDefault());
      contents.on("will-frame-navigate", (event) => event.preventDefault());
      contents.on("will-attach-webview", (event) => event.preventDefault());
      return await new Promise<Output>((resolve, reject) => {
        const abort = () => reject(parent.aborted ? parent.reason : failed());
        const gone = () => reject(failed());
        const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
          event.sender === contents &&
          event.senderFrame === contents.mainFrame &&
          event.senderFrame?.url === entry;
        let sent = false;
        const result = (event: Electron.IpcMainEvent, value: unknown) => {
          if (!sent || !trusted(event)) return;
          const parsed = HostMethods["host.office.render"].result.safeParse(value);
          if (
            !parsed.success ||
            parsed.data.some((page) => !params.pages.includes(page.page) || !validPng(page))
          )
            reject(failed());
          else resolve(parsed.data);
        };
        cleanup = () => {
          signal.removeEventListener("abort", abort);
          ipcMain.removeHandler(channel);
          ipcMain.removeListener(`${channel}:result`, result);
          contents.removeListener("render-process-gone", gone);
          owner.removeListener("closed", gone);
        };
        ipcMain.handle(channel, (event) => {
          if (sent || signal.aborted || !trusted(event)) return null;
          sent = true;
          return {
            ...params,
            edge: OFFICE_RENDER_EDGE,
            pixels: OFFICE_RENDER_PIXELS,
            pageBytes: OFFICE_RENDER_PAGE_BYTES,
          };
        });
        ipcMain.on(`${channel}:result`, result);
        contents.once("render-process-gone", gone);
        owner.once("closed", gone);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else void owner.loadURL(entry).catch(gone);
      });
    } finally {
      cleanup?.();
      if (window && !window.isDestroyed()) window.destroy();
    }
  }
  return {
    async render(params: Input, signal: AbortSignal) {
      // One hidden window at a time bounds memory; a second Bot waits its turn instead of
      // failing, and its own signal still cancels it while queued (perform checks it first).
      const previous = active;
      const operation = (async () => {
        if (previous) await previous.catch(() => undefined);
        return perform(params, AbortSignal.any([signal, lifetime.signal]));
      })();
      active = operation;
      try {
        return await operation;
      } finally {
        if (active === operation) active = undefined;
      }
    },
    async dispose() {
      lifetime.abort();
      // The RPC caller handles the failure; disposal only waits for window/IPC cleanup.
      await Promise.allSettled(active ? [active] : []);
      if (!isolated) return;
      isolated.webRequest.onBeforeRequest(null);
      isolated.setPermissionRequestHandler(null);
      isolated.setPermissionCheckHandler(null);
      isolated.removeListener("will-download", denyDownload);
      isolated = undefined;
    },
  };
}
