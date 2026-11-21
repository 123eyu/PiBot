import { attachCdp } from "../cdp.ts";
import { createBrowserDiagnostics } from "../debug/debug-diagnostics.ts";
import { createNetworkLog } from "../debug/network-log.ts";
import { userAgentOverride } from "../login/google-compat.ts";
import {
  BASE_SELECT_CSS,
  GUARD_BINDING,
  GUARD_SCRIPT,
  GUARD_WORLD,
  RECORD_BINDING,
} from "../page/page-scripts.ts";
import type { BrowserWindow } from "../platform.ts";
import type { BotTabOperations } from "../tab.ts";
import { errorName, noOpener, tabWindowOptions } from "./tab-shared.ts";

/** Every handler a tab window needs, fresh or adopted; synchronous on purpose (see adopt). */
export function wireStep(this: BotTabOperations, window: BrowserWindow) {
  this.window = window;
  this.platform.prepareTabWindow(window);
  // Closing the takeover window (title bar, Cmd+W, Alt+F4) puts the page back in the background
  // instead of destroying the tab: the takeover goes on in the app until the user hands back.
  // A page's own window.close() does not pass here (measured); it only ends in "closed".
  window.on("close", (event) => {
    if (this.presented && this.events.windowClosing()) event.preventDefault();
  });
  window.on("closed", () => {
    if (!this.closing) this.events.closed();
  });
  // A page that closes its own takeover window leaves nothing to ask afterwards; the next
  // window takes the place this one was last moved or sized to.
  const track = () => {
    if (this.presented && !window.isDestroyed()) this.lastBounds = window.getBounds();
  };
  window.on("move", track);
  window.on("resize", track);
  const contents = window.webContents;
  contents.setUserAgent(this.userAgent);
  // Cancelling here keeps the current document; a webRequest cancel would commit an error page
  // and invalidate every ref the Bot holds. Async address checks still run in webRequest.
  contents.on("will-navigate", (event) => {
    if (!this.events.allowNavigation(event.url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url, features }) =>
    this.events.windowOpen(url, !noOpener(features))
      ? {
          action: "allow",
          // As in a browser, a popup stays when the page that opened it goes away.
          outlivesOpener: true,
          overrideBrowserWindowOptions: tabWindowOptions(this.session),
        }
      : { action: "deny" },
  );
  contents.on("did-create-window", (popup, { url }) => this.events.popupCreated(popup, url));
  contents.on("dom-ready", () => {
    void contents.insertCSS(BASE_SELECT_CSS).catch(() => {
      // A page that navigates away mid-insert simply gets the rule on its next dom-ready.
    });
  });
  contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
    // -3 is ERR_ABORTED (superseded navigation), not a page failure.
    if (!mainFrame || code === -3) return;
    this.lastError = errorName(description);
    this.events.loadFailed(url, this.lastError, code);
  });
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    this.lastError = undefined;
    // Start a new diagnostic scope before its Document response can arrive. Clearing at
    // commit would erase this navigation's own HTTP failure, which arrives before commit.
    this.resetDebug();
    if (this.popup) {
      this.followIdentity(details.url);
      return;
    }
    // Each committed page sees one identity; switching here applies to this navigation
    // (measured: browser loads, link clicks, back and reload).
    const userAgent = this.events.userAgentFor(details.url);
    this.identity = userAgent;
    if (contents.getUserAgent() !== userAgent) contents.setUserAgent(userAgent);
  });
  contents.on("will-redirect", (details) => {
    if (!details.isMainFrame) return;
    // A popup switches in place (adopt): a fresh load is browser-initiated and severs
    // window.opener, so an OAuth callback could not post its result back
    // (seen with a site whose Google sign-in popup stayed on a spinner).
    if (this.popup) {
      this.followIdentity(details.url);
      return;
    }
    const userAgent = this.events.userAgentFor(details.url);
    if (contents.getUserAgent() === userAgent) return;
    // Switching the webContents user agent inside a redirect crashes Electron
    // (did-redirect-navigation) or ends on the previous page (will-redirect), measured in
    // sign-in tests. Cancel and load the target afresh under the new identity; a 307/308
    // POST body does not survive that.
    details.preventDefault();
    this.identity = userAgent;
    contents.setUserAgent(userAgent);
    void contents.loadURL(details.url).catch(() => {
      // A failed load reports itself through did-fail-load like any other.
    });
  });
  return contents;
}

/** Debugger, guard world and page events; the window already has a document. */
export async function attachStep(this: BotTabOperations): Promise<void> {
  const cdp = attachCdp(this.contents, this.platform.htmlText);
  this.cdp = cdp;
  // An adopted popup's first document is already on its way. Dispatch identity before
  // any optional diagnostic command can yield to that navigation.
  if (this.identity !== this.userAgent) this.sendIdentity();
  cdp.on("Page.frameNavigated", (params) => {
    const frame = params.frame as { parentId?: string; url?: string };
    if (frame.parentId) return;
    this.refs.reset();
    this.resetDebug(false);
    this.events.navigated(String(frame.url ?? ""));
  });
  cdp.on("Runtime.bindingCalled", (params) => {
    if (params.name === GUARD_BINDING) {
      try {
        const value = JSON.parse(String(params.payload)) as {
          method?: unknown;
          action?: unknown;
        };
        this.events.submitBlocked({ method: String(value.method), action: String(value.action) });
      } catch {
        // Malformed payloads can only come from a broken guard world; nothing to report.
      }
    } else if (params.name === RECORD_BINDING) this.events.record(String(params.payload));
  });
  cdp.on("Page.javascriptDialogOpening", (params) => {
    // A hidden window has nobody to answer; leaving it open would freeze the page. In the
    // takeover window the user answers it like in any browser.
    if (this.presented) return;
    void cdp
      .send("Page.handleJavaScriptDialog", { accept: params.type === "beforeunload" })
      .catch(() => {});
  });
  cdp.on("Page.fileChooserOpened", () => this.events.fileChooser());
  // Sent back to back (the debugger still runs them in this order): an adopted popup's first
  // document is already on its way, and the guard should be in it as early as possible.
  // `runImmediately` also installs it into a document that committed before the script did.
  const guarded = Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }),
    cdp.send("Runtime.addBinding", { name: GUARD_BINDING, executionContextName: GUARD_WORLD }),
    cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: GUARD_SCRIPT,
      worldName: GUARD_WORLD,
      runImmediately: true,
    }),
  ]);
  this.diagnostics = createBrowserDiagnostics(cdp, {
    enabled: () => this.debugOptions?.enabled() === true,
    redact: this.redact,
  });
  // Takeover diagnostics stay in a separate bounded buffer; agent tools cannot read it.
  this.networkLog = createNetworkLog(cdp, () => this.debugOptions?.enabled() === true, this.redact);
  this.userDiagnostics = createBrowserDiagnostics(cdp, {
    enabled: () => this.debugOptions?.userEnabled?.() === true,
    redact: this.redact,
  });
  await guarded;
  cdp.on("Runtime.bindingCalled", (params) => {
    if (params.name === "pibotDebugViewChanged") this.invalidateView();
  });
  try {
    await cdp.send("Runtime.addBinding", {
      name: "pibotDebugViewChanged",
      executionContextName: "pibot-debug-observer",
    });
    // Geometry changes invalidate coordinate selection. Ordinary DOM updates do not:
    // a clock or animation must not make every published frame immediately stale.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      worldName: "pibot-debug-observer",
      runImmediately: true,
      source: `(() => { let pending = false; const changed = () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; globalThis.pibotDebugViewChanged("changed"); }); }; addEventListener("scroll",changed,true); addEventListener("resize",changed); })()`,
    });
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    this.debugSupported = true;
  } catch {
    this.debugSupported = false; /* Optional debug capability must not disable browsing. */
  }
}

/** In a popup (adopt): the identity of the document at this address, when it changes. */
export function followIdentityStep(this: BotTabOperations, url: string): void {
  const userAgent = this.events.userAgentFor(url);
  if (userAgent === this.identity) return;
  this.identity = userAgent;
  this.sendIdentity();
}

export function sendIdentityStep(this: BotTabOperations): void {
  void this.cdp
    ?.send(
      "Emulation.setUserAgentOverride",
      userAgentOverride(this.identity, this.userAgent, this.events.userAgentMetadata()),
    )
    .catch(() => {
      // Only a window going away fails here; its next document never comes.
    });
}

export function closeStep(this: BotTabOperations): void {
  this.takeoverToolbar?.dispose();
  this.takeoverToolbar = undefined;
  this.closing = true;
  this.presented = undefined;
  this.stopCast?.();
  this.diagnostics?.dispose();
  this.diagnostics = undefined;
  this.networkLog?.dispose();
  this.networkLog = undefined;
  this.userDiagnostics?.dispose();
  this.userDiagnostics = undefined;
  this.resetDebug();
  this.cdp?.detach();
  this.cdp = undefined;
  if (this.window && !this.window.isDestroyed()) this.window.destroy();
  this.window = undefined;
}
