import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { browserProfileKey, IdSchema, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import { BotBrowser, type BrowserPool } from "./bot-browser.ts";
import type { BrowserPlatform } from "./platform.ts";
import { SLEEP_FILE } from "./sleep.ts";
import type { BotBrowserOptions, BrowserIdentity } from "./types.ts";

export type { BotBrowser } from "./bot-browser.ts";
export type { BotBrowserOptions, BrowserFrame, BrowserGuard } from "./types.ts";

/**
 * At most this many Bots have pages open at once (each page process is
 * ~120–170 MB). The next Bot to open one closes the pages of the least recently used other Bot;
 * its session (cookies, logins) stays on disk and its next browser_open reopens a page.
 */
export const MAX_BOTS_WITH_PAGES = 3;

/**
 * Sites treat the Electron/app tokens as an unknown browser; present plain Chromium. The app
 * token is the name without spaces ("PiBotDev/0.0.0" for "Pi Bot Dev" was once left in),
 * so drop whatever sits between the engine and the Chrome token instead of matching the name.
 */
function chromiumUserAgent(app: BrowserPlatform["app"]) {
  return app.userAgentFallback
    .replace(/(\(KHTML, like Gecko\)) .*?(Chrome\/)/, "$1 $2")
    .replace(/ Electron\/\S+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pages read `navigator.languages` from the system's preferred languages, but
 * Electron sends only the app locale as Accept-Language; a header that disagrees with the page's
 * own list is a classic non-browser sign. Send the same list, in the same order. Session-wide,
 * so every frame (cross-site iframes included) sends it.
 */
function acceptLanguages(app: BrowserPlatform["app"]) {
  const languages = [...new Set(app.getPreferredSystemLanguages().filter(Boolean))];
  return (languages.length ? languages : [app.getLocale()]).slice(0, 10).join(",");
}

/**
 * All Bot browsers of this background process. Created with the brain host; `closeAll()`
 * runs whenever the brain child goes away (standby, restart) and `dispose()` on host stop.
 */
export function createBotBrowsers(options: BotBrowserOptions) {
  const app = options.platform.app;
  const browsers = new Map<string, BotBrowser>();
  let disposed = false;
  let identity: BrowserIdentity | undefined;
  // A takeover window hides instead of closing, which would otherwise cancel app.quit().
  // Listened to from the first Bot browser on (see get()) until dispose().
  let quitting = false;
  const onQuit = () => {
    quitting = true;
  };
  const pool: BrowserPool = {
    quitting: () => quitting,
    opening(browser) {
      const others = [...browsers.values()].filter((b) => b !== browser && b.open);
      const excess = others.length - (MAX_BOTS_WITH_PAGES - 1);
      if (excess <= 0) return;
      const victims = others
        .filter((b) => b.evictable)
        .sort((a, b) => a.lastUsed - b.lastUsed)
        .slice(0, excess);
      // Every other open Bot is mid-action, watched, taken over or recording: closing any of
      // them would break what someone is doing, so this Bot waits and retries instead.
      if (victims.length < excess) throw new RpcError(RpcErrorCodes.busy, "browser_bot_limit");
      for (const victim of victims) {
        options.logger.info(
          `browser.evicted botId=${victim.botId} for=${browser.botId} limit=${MAX_BOTS_WITH_PAGES}`,
        );
        // onActivity(false) and host.browser.status (no longer listed) tell brain it is released.
        victim.closePages("remember");
      }
    },
  };
  const get = (botId: string, groupId?: string) => {
    const key = browserProfileKey(botId, groupId);
    if (disposed) throw new RpcError(RpcErrorCodes.closed, "browser_closed");
    let browser = browsers.get(key);
    if (!browser) {
      if (!identity) {
        identity = { userAgent: chromiumUserAgent(app), acceptLanguages: acceptLanguages(app) };
        // A cross-site iframe runs in its own renderer, whose navigator.userAgent comes
        // from the process-wide fallback, not the tab's override (it still said Electron). No
        // page of ours reads the user agent, so the whole process presents plain Chromium.
        app.userAgentFallback = identity.userAgent;
        app.on("before-quit", onQuit);
      }
      browser = new BotBrowser(botId, options, identity, pool, groupId);
      browsers.set(key, browser);
    }
    return browser;
  };
  return {
    get,
    async clearGroup(groupId: string) {
      const ids = new Set(
        [...browsers.values()]
          .filter((value) => value.groupId === groupId)
          .map((value) => value.botId),
      );
      const directory = options.groupProfilesDir?.(groupId);
      if (directory) {
        const entries = await readdir(directory, { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        if (entries.length > 1000) throw new RpcError(RpcErrorCodes.busy, "browser_profile_limit");
        for (const entry of entries)
          if (
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            IdSchema.safeParse(entry.name).success
          )
            ids.add(entry.name);
      }
      const values = [...ids].map((botId) => get(botId, groupId));
      if (values.some((value) => value.takeover || value.recordingActive))
        throw new RpcError(RpcErrorCodes.busy, "browser_takeover");
      for (const value of values) await value.clearData();
    },
    /** Existing instance only; status and release must not create sessions. */
    find: (botId: string, groupId?: string) => browsers.get(browserProfileKey(botId, groupId)),
    /**
     * Like find, but a Bot whose pages went to sleep before the brain went away (saved
     * list on disk) gets its instance back, so the side pane can show the sleeping tabs.
     */
    peek: (botId: string, groupId?: string) =>
      browsers.get(browserProfileKey(botId, groupId)) ??
      (!disposed && existsSync(join(options.profileDir(botId, groupId), SLEEP_FILE))
        ? get(botId, groupId)
        : undefined),
    status: () =>
      [...browsers.values()]
        .filter((browser) => browser.open)
        .map((browser) => ({
          botId: browser.botId,
          ...(browser.groupId ? { groupId: browser.groupId } : {}),
          tabs: browser.tabCount,
          busy: browser.busy,
        })),
    active: () => [...browsers.values()].some((browser) => browser.open),
    closeAll() {
      for (const browser of browsers.values()) browser.dispose("remember");
      browsers.clear();
    },
    dispose() {
      disposed = true;
      if (identity) app.off("before-quit", onQuit);
      for (const browser of browsers.values()) browser.dispose();
      browsers.clear();
    },
  };
}
export type BotBrowsers = ReturnType<typeof createBotBrowsers>;
export type { UserBrowser } from "./extension-route.ts";
export { createNavigationCheck } from "./network.ts";
