import { join } from "node:path";
import type { BotBrowser, BotTab, BrowserWindow as HostWindow } from "@pibot/browser/host";
import type { Logger } from "@pibot/observability";
import {
  type LoginFillResult,
  type MethodParams,
  type MethodResults,
  type Settings,
  TakeoverToolbarMethods,
  TakeoverToolbarRequestSchema,
  type TakeoverToolbarState,
  TakeoverToolbarStateSchema,
} from "@pibot/protocol";
import {
  type BrowserWindow,
  ipcMain,
  nativeTheme,
  View,
  type WebContents,
  WebContentsView,
} from "electron";

const CHANNEL = "pibot:takeover-toolbar";
const HEIGHT = 56;
type Profile = { botId: string; groupId?: string };
interface ToolbarEntry {
  contents: WebContents;
  notify(): void;
  present(window: BrowserWindow): void;
  unpresent(): void;
  dispatch(input: unknown): Promise<TakeoverToolbarState | LoginFillResult | { ok: true }>;
  dispose(): void;
}
export interface TakeoverToolbarRequests {
  accounts(
    params: MethodParams["credentials.takeoverAccounts"],
    signal: AbortSignal,
  ): Promise<MethodResults["credentials.takeoverAccounts"]>;
  fill(
    params: MethodParams["credentials.fillForTakeover"],
    signal: AbortSignal,
  ): Promise<MethodResults["credentials.fillForTakeover"]>;
  handBack(params: Profile, signal: AbortSignal): Promise<void>;
  settings(signal: AbortSignal): Promise<Pick<Settings, "language" | "theme">>;
  botName(botId: string, signal: AbortSignal): Promise<string>;
}

/** Host-owned views only; no business port or credential capability is exposed to a website. */
export function createTakeoverToolbars(options: {
  outputDir: string;
  devUrl?: string;
  request: TakeoverToolbarRequests;
  logger: Pick<Logger, "warn">;
}) {
  const shutdown = new AbortController();
  const entries = new Map<number, ToolbarEntry>();
  function createEntry(browser: BotBrowser, tab: BotTab): ToolbarEntry {
    const profile: Profile = {
      botId: browser.botId,
      ...(browser.groupId ? { groupId: browser.groupId } : {}),
    };
    const view = new WebContentsView({
      webPreferences: {
        preload: join(options.outputDir, "..", "preload", "browser-takeover.cjs"),
        partition: "pibot-takeover-toolbar",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const contents = view.webContents;
    const contentsId = contents.id;
    const siteContents = tab.contents as unknown as import("electron").WebContents;
    const stopping = new AbortController();
    let window: BrowserWindow | undefined;
    let website: View | undefined;
    let container: View | undefined;
    let active = false;
    let pending = 0;
    let fillBusy = false;
    const signal = () =>
      AbortSignal.any([shutdown.signal, stopping.signal, AbortSignal.timeout(25_000)]);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    const notify = () => {
      if (active && !contents.isDestroyed()) contents.send(`${CHANNEL}:changed`);
    };
    const layout = () => {
      if (!window || window.isDestroyed() || !website) return;
      const [width = 1280, height = 800] = window.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height: HEIGHT });
      website.setBounds({ x: 0, y: HEIGHT, width, height: Math.max(1, height - HEIGHT) });
    };
    const unpresent = () => {
      active = false;
      if (!window || !website) return;
      window.off("resize", layout);
      if (!window.isDestroyed()) {
        container?.removeChildView(website);
        container?.removeChildView(view);
        window.setContentView(website);
        const [width = 1280, height = 800] = window.getContentSize();
        website.setBounds({ x: 0, y: 0, width, height });
      }
      website = undefined;
      container = undefined;
      window = undefined;
    };
    const entry = {
      contents,
      notify,
      present(target: BrowserWindow) {
        if (active) {
          notify();
          return;
        }
        if (stopping.signal.aborted || target.isDestroyed()) return;
        active = true;
        window = target;
        website = target.contentView;
        container = new View();
        target.setContentView(container);
        container.addChildView(website);
        container.addChildView(view);
        target.on("resize", layout);
        layout();
        notify();
      },
      unpresent,
      async dispatch(input: unknown) {
        if (
          !active ||
          !browser.takeover ||
          browser.recordingActive ||
          browser.shownTab !== tab.id ||
          pending >= 8
        )
          throw new Error("takeover_toolbar_unavailable");
        const call = TakeoverToolbarRequestSchema.parse(input);
        pending++;
        try {
          const current = signal();
          if (call.method === "getState") {
            const [snapshot, settings, botName] = await Promise.all([
              options.request.accounts(profile, current),
              options.request.settings(current),
              options.request.botName(browser.botId, current),
            ]);
            current.throwIfAborted();
            return TakeoverToolbarStateSchema.parse({
              botId: browser.botId,
              botName,
              page: snapshot?.page ?? null,
              documentId: snapshot?.documentId ?? null,
              accounts: snapshot?.accounts ?? [],
              language:
                settings.language === "system"
                  ? Intl.DateTimeFormat().resolvedOptions().locale.startsWith("zh")
                    ? "zh"
                    : "en"
                  : settings.language,
              theme:
                settings.theme === "system"
                  ? nativeTheme.shouldUseDarkColors
                    ? "dark"
                    : "light"
                  : settings.theme,
            });
          }
          if (call.method === "handBack") {
            // Successful hand-back destroys this toolbar; that must not cancel its own RPC.
            await options.request.handBack(
              profile,
              AbortSignal.any([shutdown.signal, AbortSignal.timeout(25_000)]),
            );
            return { ok: true as const };
          }
          if (fillBusy) throw new Error("takeover_toolbar_busy");
          fillBusy = true;
          try {
            return TakeoverToolbarMethods.fill.result.parse(
              await options.request.fill({ ...profile, ...call.params }, current),
            );
          } finally {
            fillBusy = false;
          }
        } finally {
          pending--;
        }
      },
      dispose() {
        if (stopping.signal.aborted) return;
        stopping.abort();
        unpresent();
        entries.delete(contentsId);
        siteContents.off("did-navigate", notify);
        siteContents.off("did-navigate-in-page", notify);
        if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      },
    };
    entries.set(contents.id, entry);
    siteContents.on("did-navigate", notify);
    siteContents.on("did-navigate-in-page", notify);
    const loaded = options.devUrl
      ? contents.loadURL(`${options.devUrl.replace(/\/$/, "")}/#browser-takeover`)
      : contents.loadFile(join(options.outputDir, "..", "renderer", "index.html"), {
          hash: "browser-takeover",
        });
    void loaded.catch(() => options.logger.warn("takeover toolbar unavailable"));
    return entry;
  }
  function attach(browser: BotBrowser, tab: BotTab) {
    let entry: ToolbarEntry | undefined;
    let disposed = false;
    const toolbar = {
      present(window: HostWindow) {
        if (disposed || shutdown.signal.aborted) return;
        entry ??= createEntry(browser, tab);
        entry.present(window as BrowserWindow);
      },
      unpresent() {
        entry?.dispose();
        entry = undefined;
      },
      dispose() {
        disposed = true;
        entry?.dispose();
        entry = undefined;
      },
    };
    tab.setTakeoverToolbar(toolbar);
    return toolbar;
  }
  ipcMain.handle(CHANNEL, async (event, input) => {
    const entry = entries.get(event.sender.id);
    if (!entry || event.senderFrame !== entry.contents.mainFrame) return { ok: false };
    try {
      return { ok: true, result: await entry.dispatch(input) };
    } catch {
      return { ok: false };
    }
  });
  nativeTheme.on("updated", notifyAll);
  function notifyAll() {
    for (const entry of entries.values()) entry.notify();
  }
  return {
    attach,
    notifyAll,
    dispose() {
      shutdown.abort();
      for (const entry of [...entries.values()]) entry.dispose();
      nativeTheme.off("updated", notifyAll);
      ipcMain.removeHandler(CHANNEL);
    },
  };
}
