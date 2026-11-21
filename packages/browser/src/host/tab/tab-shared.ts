import type { UserAgentMetadata } from "../login/google-compat.ts";
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "../platform.ts";

export const MOUSE = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;

export interface TabEvents {
  /**
   * The page asks for a new window. True lets Electron create it as a real popup with this page
   * as its `window.opener` (then handed over through popupCreated); false refuses it.
   */
  windowOpen(url: string, opener: boolean): boolean;
  /** The popup window windowOpen allowed, before its first navigation (to `url`) starts. */
  popupCreated(window: BrowserWindow, url: string): void;
  /** The window went away without close() (the page's window.close(), a crash teardown). */
  closed(): void;
  /** Synchronous site rules for page-initiated navigations; false keeps the current page. */
  allowNavigation(url: string): boolean;
  submitBlocked(request: { method: string; action: string }): void;
  fileChooser(): void;
  record(payload: string): void;
  navigated(url: string): void;
  /** A main-frame load failed for another reason than being superseded (ERR_ABORTED). */
  loadFailed(url: string, error: string, code: number): void;
  /**
   * The user closed the takeover window. True keeps the tab (the window goes back to the
   * background); false lets the window close, e.g. while the app quits.
   */
  windowClosing(): boolean;
  /** The identity (user agent) a page at this address loads with. */
  userAgentFor(url: string): string;
  /** The engine's client hints for a popup's Firefox identity, once known. */
  userAgentMetadata(): UserAgentMetadata | undefined;
}

/** A tab window, fresh or a page's popup (Electron creates popups with the same options). */
export function tabWindowOptions(session: Session): BrowserWindowConstructorOptions {
  return {
    show: false,
    width: 1280,
    height: 800,
    // mac: the overlay's viewport (up to 1600 px tall) must survive a once-shown window being
    // ordered in to resize (redrawHidden); AppKit would cut it to the screen otherwise.
    enableLargerThanScreen: true,
    webPreferences: {
      session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
      safeDialogs: true,
    },
  };
}

/**
 * `window.open(url, name, "noopener")` / `"noreferrer"` (the latter implies the former): the page
 * gave up its opener, so the popup opens as an ordinary new tab like before. A `target=_blank`
 * link is implicitly noopener but shows no feature; Electron then creates it without an opener.
 */
export function noOpener(features: string) {
  return features
    .split(/[\s,]+/)
    .map((feature) => feature.split("=", 2) as [string, string?])
    .some(
      ([name, value]) =>
        /^no(opener|referrer)$/i.test(name) &&
        (value === undefined || !/^(no|0|false)$/i.test(value.trim())),
    );
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const pick = <T extends object, K extends keyof T>(value: T, keys: K[]) =>
  Object.fromEntries(keys.map((key) => [key, value[key]]));

export function errorName(description: string) {
  const name = /ERR_[A-Z0-9_]{1,80}/.exec(description)?.[0];
  return name ?? "ERR_FAILED";
}
