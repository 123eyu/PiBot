import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type BrowserDownload, type BrowserRules, RpcError } from "@pibot/browser-contract/full";
import type { DownloadItem, HostEvent, Session, WebContents } from "./platform.ts";

const MAX_BYTES = 500 * 1024 * 1024;
const MAX_KEPT = 100;

function safeName(raw: string) {
  const name = basename(raw.replaceAll("\\", "/"))
    // Control characters, separators and characters Windows refuses.
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 200);
  return name || "download";
}

function uniquePath(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = join(dir, i ? `${stem} (${i})${ext}` : name);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${randomUUID()}${ext}`);
}

/**
 * Downloads land in the run's `<primary writable root>/downloads`; without one they
 * are cancelled. Never overwrites, bounded size, list kept in memory per Bot.
 */
export function installDownloads(
  session: Session,
  hooks: {
    rules(): BrowserRules | undefined;
    ownsSource(webContentsId: number): boolean;
    blocked(url: string): void;
    saved(entry: BrowserDownload): void;
    failed(): void;
  },
) {
  const list: BrowserDownload[] = [];
  const active = new Set<DownloadItem>();
  const onDownload = (_event: HostEvent, item: DownloadItem, source?: WebContents) => {
    const dir = hooks.rules()?.downloadsDir;
    if (!dir || !source || !hooks.ownsSource(source.id) || item.getTotalBytes() > MAX_BYTES) {
      item.cancel();
      hooks.blocked(item.getURL());
      return;
    }
    let path: string;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      path = uniquePath(dir, safeName(item.getFilename()));
      // Must be set synchronously; otherwise Electron would show a save dialog.
      item.setSavePath(path);
    } catch {
      item.cancel();
      hooks.failed();
      return;
    }
    const entry: BrowserDownload = {
      id: randomUUID(),
      filename: basename(path),
      path,
      state: "progressing",
      receivedBytes: 0,
      totalBytes: Math.max(0, item.getTotalBytes()),
      startedAt: new Date().toISOString(),
    };
    list.push(entry);
    if (list.length > MAX_KEPT) list.shift();
    active.add(item);
    item.on("updated", () => {
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = Math.max(0, item.getTotalBytes());
      if (entry.receivedBytes > MAX_BYTES) item.cancel();
    });
    item.once("done", (_e, state) => {
      active.delete(item);
      entry.receivedBytes = item.getReceivedBytes();
      entry.state = state;
      if (state !== "completed") entry.path = null;
      else hooks.saved(entry);
    });
  };
  session.on("will-download", onDownload);
  return {
    list: () => list.map((entry) => ({ ...entry })),
    async cancelActive() {
      await Promise.all(
        [...active].map(
          (item) =>
            new Promise<void>((accept, reject) => {
              const finish = () => {
                clearTimeout(timer);
                item.off("done", done);
                accept();
              };
              const done = () => finish();
              const timer = setTimeout(() => {
                item.off("done", done);
                reject(new RpcError(-32011, "browser_download_cancel_failed"));
              }, 10_000);
              item.once("done", done);
              try {
                item.cancel();
                if (item.getState() !== "progressing") finish();
              } catch {
                clearTimeout(timer);
                item.off("done", done);
                reject(new RpcError(-32011, "browser_download_cancel_failed"));
              }
            }),
        ),
      );
    },
    dispose() {
      session.off("will-download", onDownload);
      for (const item of active) item.cancel();
      active.clear();
    },
  };
}
