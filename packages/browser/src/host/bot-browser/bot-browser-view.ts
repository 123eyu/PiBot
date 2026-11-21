import { type HostBrowserInputEvent, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { BotBrowserOperations } from "../bot-browser.ts";
import type { BrowserFrame } from "../types.ts";
import { busy, domainOf, fitDisplay } from "./bot-browser-shared.ts";

export async function setTakeoverStep(this: BotBrowserOperations, on: boolean, window = true) {
  if (on)
    for (const read of this.temporaryReads.values())
      read.controller.abort(busy("browser_takeover"));
  // The user drives the tab they are looking at; hand-back leaves the Bot there.
  if (on && this.viewed && this.tabs.has(this.viewed)) this.active = this.viewed;
  this.viewed = undefined;
  this.takeover = on;
  for (const tab of this.tabs.values()) tab.resetDebug();
  this.windowed = on && !this.recording.active && window;
  this.touch();
  for (const tab of this.tabs.values()) await this.armSubmit(tab);
  this.syncWindow();
}

/** "show window" in the app during a takeover; brings the window back to the front. */
export function showWindowStep(this: BotBrowserOperations) {
  if (!this.takeover || this.recording.active) return;
  this.windowed = true;
  this.touch();
  const tab = this.presented ? this.tabs.get(this.presented) : undefined;
  if (tab) tab.present();
  else this.syncWindow();
}

/**
 * During a takeover the shown tab is a real desktop window and follows tab switches like
 * the overlay stream does; otherwise every tab is a hidden background window. The next window
 * opens before the previous one hides, so focus moves between them instead of leaving the app.
 */
export function syncWindowStep(this: BotBrowserOperations): void {
  const id = this.takeover && this.windowed ? this.shownTab : undefined;
  const handover = this.handover;
  this.handover = undefined;
  if (id === this.presented) return;
  const previous = this.presented ? this.tabs.get(this.presented) : undefined;
  const next = id ? this.tabs.get(id) : undefined;
  const bounds = previous?.windowBounds ?? handover;
  this.presented = next ? id : undefined;
  next?.present(bounds);
  if (previous) {
    previous.unpresent();
    // Back to the size the overlay fitted it to.
    previous.setViewportHeight(this.display?.viewportHeight);
  }
}

/**
 * Overlay input; only while the user has taken over (teaching runs under takeover too),
 * and only to the tab the overlay shows. Input still on its way to a tab that went away or
 * stopped being shown (a sign-in popup closing itself, a tab switch) is dropped, never sent to
 * whatever tab is shown now: its coordinates and keys were meant for the other page. The
 * overlay moves to the shown tab on its next frame. Returns false when dropped.
 */
export async function inputStep(
  this: BotBrowserOperations,
  tabId: string,
  event: HostBrowserInputEvent,
) {
  if (!this.takeover) throw busy("browser_not_taken_over");
  this.touch();
  // The tab directly: tab() would spend the Bot's one-time "the user closed your tab" notice
  // on the user's own next click and fail that click.
  const tab = this.tabs.get(tabId);
  if (!tab || this.shownTab !== tabId) {
    this.dropInput(tabId, tab ? "tab_not_shown" : "tab_closed");
    return false;
  }
  try {
    await tab.dispatch(event);
  } catch (error) {
    if (!(error instanceof RpcError && error.code === RpcErrorCodes.closed)) throw error;
    this.dropInput(tabId, "tab_closed");
    return false;
  }
  return true;
}

export function dropInputStep(
  this: BotBrowserOperations,
  tabId: string,
  reason: "tab_closed" | "tab_not_shown",
): void {
  // A mouse move stream keeps coming until the overlay shows the next frame: one line per tab.
  if (this.droppedInputTab === tabId) return;
  this.droppedInputTab = tabId;
  this.options.logger.warn(
    `browser input dropped botId=${this.botId} tab=${tabId} reason=${reason}`,
  );
}

/** Overlay tab strip. Outside takeover only the view changes, not the Bot's active tab. */
export function switchViewStep(this: BotBrowserOperations, id: string): void {
  this.tab(id);
  if (this.takeover) {
    this.active = id;
    this.viewed = undefined;
  } else this.viewed = id === this.active ? undefined : id;
  this.touch();
  this.recast();
}

/**
 * The address bar, back and reload (during takeover and at any other time). The user's own
 * address is not asked about (it is theirs, like takeover) but the host rules still apply:
 * private addresses and the only-allowed list are refused with the notice page. While the Bot
 * is acting on that tab, a typed address opens in a new tab instead of pulling the page away.
 * Returns the tab the page opens in.
 */
export async function userNavigateStep(
  this: BotBrowserOperations,
  tabId: string,
  action: "url" | "back" | "forward" | "reload",
  url?: string,
) {
  const tab = this.tabs.get(tabId);
  if (!tab) throw new RpcError(RpcErrorCodes.invalidParams, "browser_tab_not_found");
  this.touch();
  const botOnIt = this.running > 0 && tabId === this.active && !this.takeover;
  if (action !== "url") {
    if (botOnIt) throw busy("browser_bot_acting");
    const history = tab.contents.navigationHistory;
    if (action === "reload") tab.contents.reload();
    else if (action === "forward") {
      if (history.canGoForward?.()) history.goForward?.();
    } else if (history.canGoBack()) history.goBack();
    return tabId;
  }
  const domain = url ? domainOf(url) : "";
  if (!url || !/^https?:[/][/]/i.test(url) || !domain)
    throw new RpcError(RpcErrorCodes.invalidParams, "browser_unsupported_url");
  this.opened.add(domain);
  const target = botOnIt ? await this.newTab({ user: true }) : tab;
  if (!botOnIt && !this.takeover && this.running === 0 && this.active !== tabId) {
    // The page the user opened is where the Bot continues.
    this.active = tabId;
    this.viewed = undefined;
    this.recast();
  }
  // Not awaited: a slow page must not hold the overlay; loading shows in the tab strip.
  void target.navigate(url, 20_000).catch(() => {});
  return target.id;
}

/** "+" in the tab strip; a blank page the user then types an address into. */
export async function userNewTabStep(this: BotBrowserOperations) {
  this.touch();
  const tab = await this.newTab({ user: true });
  return tab.id;
}

export function viewTabsStep(this: BotBrowserOperations) {
  const sleep = this.sleeping ? this.sleep : undefined;
  if (sleep)
    return sleep.tabs.map((tab) => ({
      tab: tab.id,
      url: tab.url.slice(0, 8192),
      title: tab.title.slice(0, 1000),
      active: tab.id === sleep.active,
      loading: false,
      sleeping: true,
    }));
  const shown = this.shownTab;
  return [...this.tabs.values()]
    .filter((tab) => !this.temporaryTabs.has(tab.id))
    .map((tab) => {
      const loading = tab.loading;
      return {
        tab: tab.id,
        url: tab.url.slice(0, 8192),
        title: tab.title.slice(0, 1000),
        active: tab.id === shown,
        loading,
        // A reload in progress clears it at its start; until then the failure is still on screen.
        ...(tab.lastError && !loading ? { error: tab.lastError } : {}),
      };
    });
}

/**
 * Overlay frames. The stream follows the shown tab across Bot tab changes and pauses
 * while no page is open (it resumes with the next one); only the returned stop ends it.
 */
export function startScreencastStep(
  this: BotBrowserOperations,
  onFrame: (frame: BrowserFrame) => void,
) {
  this.cast?.stopTab?.();
  const cast: { onFrame: (frame: BrowserFrame) => void; stopTab?: () => void } = { onFrame };
  this.cast = cast;
  this.recast();
  this.touch();
  return () => {
    if (this.cast !== cast) return;
    cast.stopTab?.();
    this.cast = undefined;
    // The Bot works at the default viewport again once nobody is watching.
    this.setDisplay(undefined);
    this.touch();
  };
}

/**
 * Fits the page to the overlay box: the viewport keeps its desktop width and takes the
 * box's aspect ratio as height (bounded), so the frame fills the box instead of leaving bands;
 * the screencast resolution follows the box's device pixels within a per-frame pixel budget.
 */
export function setDisplayStep(
  this: BotBrowserOperations,
  box: Parameters<typeof fitDisplay>[0] | undefined,
): void {
  const next = box ? fitDisplay(box) : undefined;
  if (JSON.stringify(next) === JSON.stringify(this.display)) return;
  this.display = next;
  for (const tab of this.tabs.values()) tab.setViewportHeight(next?.viewportHeight);
  this.recast();
}

export function recastStep(this: BotBrowserOperations): void {
  // Every change of the shown tab passes here; the takeover window follows it too.
  this.syncWindow();
  const cast = this.cast;
  if (!cast) return;
  cast.stopTab?.();
  cast.stopTab = undefined;
  const shown = this.shownTab;
  const tab = shown ? this.tabs.get(shown) : undefined;
  try {
    if (tab)
      cast.stopTab = tab.startScreencast(
        cast.onFrame,
        this.display
          ? { maxWidth: this.display.maxWidth, maxHeight: this.display.maxHeight }
          : undefined,
        undefined,
        this.display?.ackMs,
      );
  } catch {
    // A tab torn down mid-switch has no debugger; the next tab change restarts the stream.
  }
}
