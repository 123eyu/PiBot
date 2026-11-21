import { AsyncLocalStorage } from "node:async_hooks";
import {
  type BrowserViewHostMethods,
  type HostBrowserView,
  type Params,
  type Result,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import type { Logger } from "@pibot/observability";
import type { BotBrowser } from "./bot-browser.ts";
import { inspectPoint } from "./debug/debug-inspect.ts";
import type { BrowserFrames } from "./frames/browser-frames.ts";
import type { BotBrowsers } from "./index.ts";
import type { BrowserLogins } from "./login/login.ts";

type M = typeof BrowserViewHostMethods;
type Handle = <K extends keyof M>(
  method: K,
  action: (params: Params<M, K>) => Promise<Result<M, K>>,
) => void;

const closed: HostBrowserView = {
  open: false,
  tabs: [],
  takeover: false,
  viewing: false,
  recording: false,
};

export function viewState(browser: BotBrowser | undefined): HostBrowserView {
  if (!browser) return closed;
  return {
    open: browser.open,
    tabs: browser.viewTabs(),
    takeover: browser.takeover,
    viewing: browser.viewing,
    recording: browser.recordingActive,
    ...(browser.sleeping ? { sleeping: true } : {}),
  };
}

/**
 * host.browser.view.*: the overlay's controls. Runs inside host-rpc's single wrapper.
 * None of these create a browser session; acting on a Bot without one reports it closed.
 */
export function registerBrowserViewHost(
  register: Handle,
  host:
    | {
        browsers: BotBrowsers;
        frames: BrowserFrames;
        /** Login submissions seen during the takeover, reported on hand-back. */
        logins?: Pick<BrowserLogins, "takeoverStarted" | "takeSignedIn">;
      }
    | undefined,
  logger: Pick<Logger, "info">,
) {
  const requestScope = new AsyncLocalStorage<string | undefined>();
  const handle: Handle = (method, action) =>
    register(method, (params) =>
      requestScope.run(
        "groupId" in (params ?? {}) ? (params as { groupId?: string }).groupId : undefined,
        () => action(params),
      ),
    );
  const need = () => {
    if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    const groupId = requestScope.getStore();
    return {
      ...host,
      logins: groupId ? undefined : host.logins,
      browsers: {
        ...host.browsers,
        get: (botId: string) => host.browsers.get(botId, groupId),
        find: (botId: string) => host.browsers.find(botId, groupId),
        peek: (botId: string) => host.browsers.peek(botId, groupId),
      },
      frames: {
        ...host.frames,
        visible: (
          botId: string,
          visible: boolean,
          display?: import("@pibot/browser-contract/full").BrowserViewDisplay,
        ) => host.frames.visible(botId, visible, display, groupId),
        changed: (botId: string) => host.frames.changed(botId, groupId),
        remoteFrame: (botId: string, after: number, waitMs: number) =>
          host.frames.remoteFrame(botId, after, waitMs, groupId),
        remoteStop: (botId: string) => host.frames.remoteStop(botId, groupId),
      },
    };
  };
  const existing = (botId: string) => {
    const browser = need().browsers.find(botId);
    if (!browser?.open)
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_pages_closed_open_again");
    return browser;
  };
  /** Sleeping pages count as there: the user's click reopens them first. */
  const awake = async (botId: string) => {
    const browser = need().browsers.peek(botId);
    if (browser?.sleeping) {
      await browser.wake();
      need().frames.changed(botId);
    }
    return existing(botId);
  };
  const shown = (browser: BotBrowser, tab: string) => {
    if (browser.shownTab !== tab)
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_tab_not_shown");
  };
  handle("host.browser.view.debug", async ({ botId, tab, after, limit }) => {
    const browser = existing(botId);
    return browser.userDebug(
      async () => {
        const target = browser.tab(tab);
        const value = await target.debug(after, limit, "user");
        return {
          ...value,
          network: { documentId: target.documentId, ...target.network(after, limit), storage: [] },
        };
      },
      {
        readOnly: true,
      },
    );
  });
  handle("host.browser.view.inspectPoint", async ({ botId, tab, ...point }) => {
    const browser = existing(botId);
    return browser.userDebug(() => {
      shown(browser, tab);
      return inspectPoint(browser.tab(tab), point);
    });
  });
  handle("host.browser.view.state", async ({ botId }) => viewState(need().browsers.peek(botId)));
  handle("host.browser.view.visible", async ({ botId, visible, display }) => {
    const { browsers, frames } = need();
    frames.visible(botId, visible, display);
    return viewState(browsers.find(botId));
  });
  handle("host.browser.view.takeover", async ({ botId, on, window }) => {
    const { browsers, frames, logins } = need();
    const browser = on ? await awake(botId) : browsers.find(botId);
    if (browser && browser.takeover !== on) {
      if (on) logins?.takeoverStarted(botId);
      await browser.setTakeover(on, window !== false);
      // Facts only: the user's input during takeover is never logged or recorded.
      logger.info(`audit browser.takeover botId=${botId} on=${on}`);
      frames.changed(botId);
    } else if (browser && on && window !== false) {
      // Asking again during a takeover brings its window back (closed or behind others).
      browser.showWindow();
    }
    const view = viewState(browser);
    // Taken on every hand-back request, even when the host already ended the takeover itself
    // (pages disposed), so a sign-in is reported once and never carried into a later takeover.
    // Only hostnames leave this process; the account stays in the pending capture.
    const signedIn = on ? [] : (logins?.takeSignedIn(botId) ?? []);
    return signedIn.length ? { ...view, signedIn } : view;
  });
  handle("host.browser.view.input", async ({ botId, tab, event }) => {
    const browser = existing(botId);
    // Late input for a tab that went away is dropped; the overlay gets the tabs it has now.
    if (!(await browser.input(tab, event))) need().frames.changed(botId);
    return null;
  });
  handle("host.browser.view.switchTab", async ({ botId, tab }) => {
    const browser = existing(botId);
    browser.switchView(tab);
    need().frames.changed(botId);
    return viewState(browser);
  });
  handle("host.browser.view.closeTab", async ({ botId, tab }) => {
    const browser = need().browsers.peek(botId);
    if (!browser?.open && !browser?.sleeping)
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_pages_closed_open_again");
    browser.userCloseTab(tab);
    // Facts only; brain writes the audit row with the site.
    logger.info(`audit browser.tab_closed botId=${botId}`);
    need().frames.changed(botId);
    return viewState(browser);
  });
  handle("host.browser.clearData", async ({ botId }) => {
    // get(): a Bot that never opened a page this session still has a profile on disk.
    await need().browsers.get(botId).clearData();
    logger.info(`audit browser.clearData botId=${botId}`);
    return null;
  });
  handle("host.browser.clearGroupData", async ({ groupId }) => {
    await need().browsers.clearGroup(groupId);
    logger.info(`audit browser.clearGroupData groupId=${groupId}`);
    return null;
  });
  handle("host.browser.view.navigate", async ({ botId, tab, action, url }) => {
    const browser = existing(botId);
    shown(browser, tab);
    await browser.userNavigate(tab, action, url);
    // Facts only; brain writes the audit row with the site.
    logger.info(`audit browser.user_navigate botId=${botId} action=${action}`);
    need().frames.changed(botId);
    return viewState(browser);
  });
  handle("host.browser.view.wake", async ({ botId }) => viewState(await awake(botId)));
  // The phone's pull of the shared screencast; never creates a browser session.
  handle("host.browser.view.remoteFrame", async ({ botId, after, waitMs }) => {
    const { browsers, frames } = need();
    const frame = await frames.remoteFrame(botId, after, waitMs);
    return { view: viewState(browsers.find(botId)), frame };
  });
  handle("host.browser.view.remoteStop", async ({ botId }) => {
    need().frames.remoteStop(botId);
    return null;
  });
  handle("host.browser.view.newTab", async ({ botId }) => {
    const browser = need().browsers.peek(botId) ?? need().browsers.get(botId);
    if (browser.sleeping) await browser.wake();
    await browser.userNewTab();
    need().frames.changed(botId);
    return viewState(browser);
  });
}
