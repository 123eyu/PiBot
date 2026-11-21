import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HostMethods,
  type HostParams,
  type HostResults,
  IMAGE_LIMIT,
  RpcError,
  RpcErrorCodes,
  THUMBNAIL_BYTES,
} from "@pibot/protocol";
import { BrowserWindow, ipcMain, nativeImage, session, shell } from "electron";
import { z } from "zod";

export function createAttachmentHost(options: {
  dataDir: string;
  outputDir: string;
  devUrl?: string;
  partition?: string;
  openPath?(path: string): Promise<void>;
}) {
  const windows = new Set<BrowserWindow>();
  let converterSession: Electron.Session | undefined;
  const getSession = () => {
    if (!converterSession) {
      converterSession = session.fromPartition(options.partition ?? `attachment-${randomUUID()}`);
      converterSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      converterSession.setPermissionCheckHandler(() => false);
    }
    return converterSession;
  };
  // Bound the number of decoding processes even if callers bypass the chat UI.
  let busy = false;
  let disposed = false;
  const operations = new Set<Promise<unknown>>();
  const track = <T>(pending: Promise<T>) => {
    operations.add(pending);
    void pending.finally(() => operations.delete(pending)).catch(() => {});
    return pending;
  };
  async function convert<K extends "host.attachments.image" | "host.attachments.pdf">(
    method: K,
    params: HostParams[K],
  ): Promise<HostResults[K]> {
    if (disposed || busy)
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_conversion_busy");
    busy = true;
    const channel = `pibot:attachment-${randomUUID()}`;
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          offscreen: true,
          session: getSession(),
          preload: join(options.outputDir, "..", "preload", "attachments.cjs"),
          additionalArguments: [`--attachment-channel=${channel}`],
        },
      });
    } catch {
      busy = false;
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_conversion");
    }
    windows.add(window);
    const root = resolve(options.outputDir, "..", "renderer");
    const devOrigin = options.devUrl ? new URL(options.devUrl).origin : undefined;
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        if (url.protocol === "file:") {
          const path = relative(root, fileURLToPath(url));
          allowed = !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
        } else if (url.protocol === "blob:") allowed = true;
        else allowed = !!devOrigin && url.origin === devOrigin;
      } catch {
        /* Invalid URLs never leave the converter. */
      }
      callback({ cancel: !allowed });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<HostResults[K]>((accept, reject) => {
        const fail = () =>
          reject(new RpcError(RpcErrorCodes.attachmentConversion, "attachment_conversion"));
        timer = setTimeout(fail, 20_000);
        window.on("closed", fail);
        window.webContents.on("render-process-gone", fail);
        ipcMain.handle(channel, (event) => {
          if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame
          )
            return null;
          return { kind: method === "host.attachments.image" ? "image" : "pdf", params };
        });
        ipcMain.on(`${channel}:result`, (event, value: unknown) => {
          if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame
          )
            return;
          try {
            const envelope = z
              .strictObject({ ok: z.literal(true), result: HostMethods[method].result })
              .safeParse(value);
            if (!envelope.success) return fail();
            // Browser canvas handles GIF/WebP and orientation; nativeImage makes the final metadata-free PNG.
            if (method === "host.attachments.image") {
              const decoded = HostMethods["host.attachments.image"].result.parse(
                envelope.data.result,
              );
              const image = nativeImage.createFromBuffer(Buffer.from(decoded.image.data, "base64"));
              if (image.isEmpty()) return fail();
              const png = image.toPNG();
              if (png.length > IMAGE_LIMIT) {
                decoded.image.data = image.toJPEG(90).toString("base64");
                decoded.image.mimeType = "image/jpeg";
              } else decoded.image.data = png.toString("base64");
              const checked = HostMethods[method].result.safeParse(decoded);
              if (!checked.success) return fail();
              accept(checked.data as HostResults[K]);
            } else accept(envelope.data.result as HostResults[K]);
          } catch {
            fail();
          }
        });
        const loading = options.devUrl
          ? window.loadURL(new URL("/pdf/index.html", options.devUrl).href)
          : window.loadFile(join(root, "pdf", "index.html"));
        void loading.catch(fail);
      });
    } finally {
      clearTimeout(timer);
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(`${channel}:result`);
      windows.delete(window);
      if (!window.isDestroyed()) window.destroy();
      busy = false;
    }
  }
  async function ownedFile(botId: string, file: string, ...dir: string[]) {
    const root = join(
      await realpath(options.dataDir),
      "bots",
      botId,
      ...(dir.length ? dir : ["attachments"]),
    );
    const path = join(root, file);
    if (
      (await realpath(root)) !== resolve(root) ||
      (await realpath(path)) !== resolve(path) ||
      !(await lstat(path)).isFile()
    )
      throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachment_invalid");
    return path;
  }
  async function thumbnailOf(path: string, file: string) {
    const edge = 320;
    // The OS thumbnailer decodes off the main thread; Linux has none, so decode here. Its result
    // carries a 2x representation and reports a padded square size, so re-decode the encoded
    // bitmap to get the real pixels before scaling (640px thumbnails overran the preview budget).
    const system =
      process.platform === "linux"
        ? undefined
        : await nativeImage
            .createThumbnailFromPath(path, { width: edge, height: edge })
            .catch(() => undefined);
    let image =
      system && !system.isEmpty() ? nativeImage.createFromBuffer(system.toJPEG(90)) : undefined;
    if (!image || image.isEmpty()) {
      const bytes = await readFile(path);
      if (bytes.length > IMAGE_LIMIT)
        throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachment_invalid");
      image = nativeImage.createFromBuffer(bytes);
    }
    if (image.isEmpty())
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_conversion");
    const { width, height } = image.getSize();
    const scale = Math.min(1, edge / Math.max(width, height));
    if (scale < 1)
      image = image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: "good",
      });
    // Stay well inside the renderer's per-preview budget once base64-encoded.
    const budget = THUMBNAIL_BYTES;
    const png = file.endsWith(".png") ? image.toPNG() : undefined;
    if (png && png.length <= budget)
      return {
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png" as const,
      };
    let jpeg = image.toJPEG(82);
    for (const quality of [70, 55]) if (jpeg.length > budget) jpeg = image.toJPEG(quality);
    return {
      type: "image" as const,
      data: jpeg.toString("base64"),
      mimeType: "image/jpeg" as const,
    };
  }
  return {
    image: (params: HostParams["host.attachments.image"]) =>
      track(convert("host.attachments.image", params)),
    pdf: (params: HostParams["host.attachments.pdf"]) =>
      track(convert("host.attachments.pdf", params)),
    thumbnail: async ({ botId, file }: HostParams["host.attachments.thumbnail"]) =>
      thumbnailOf(await ownedFile(botId, file), file),
    // Operation-step screenshots live beside, not inside, the attachment store.
    stepThumbnail: async ({ botId, file }: HostParams["host.attachments.stepThumbnail"]) =>
      thumbnailOf(await ownedFile(botId, file, "computer", "screenshots"), file),
    // An image-diff side that brain staged briefly (and deletes after this call).
    changeThumbnail: async ({ botId, file }: HostParams["host.attachments.changeThumbnail"]) =>
      thumbnailOf(await ownedFile(botId, file, "changes", "previews"), file),
    async open({ botId, file }: HostParams["host.attachments.open"]) {
      const path = await ownedFile(botId, file);
      if (options.openPath) {
        await options.openPath(path);
        return;
      }
      const result = await shell.openPath(path);
      if (result) throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_open_failed");
    },
    async dispose() {
      disposed = true;
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      await Promise.allSettled([...operations]);
      if (converterSession) {
        // One owner partition survives cold cycles, with no stale converter handlers or connections.
        converterSession.webRequest.onBeforeRequest(null);
        converterSession.setPermissionRequestHandler(null);
        converterSession.setPermissionCheckHandler(null);
        await converterSession.closeAllConnections();
        await converterSession.clearCache();
      }
    },
  };
}
