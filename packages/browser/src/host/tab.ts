import {
  dispatchStep,
  drawnStep,
  presentStep,
  queueRedrawStep,
  redrawForCaptureStep,
  repaintStep,
  resizeStep,
  setViewportHeightStep,
  startScreencastStep,
  unpresentStep,
} from "./tab/tab-display.ts";
import {
  attachStep,
  closeStep,
  followIdentityStep,
  sendIdentityStep,
  wireStep,
} from "./tab/tab-lifecycle.ts";
import { delay, type TabEvents, tabWindowOptions } from "./tab/tab-shared.ts";

/** How long a ready document may keep loading subresources before browser_open returns. */
const LOAD_GRACE_MS = 3000;

export type { TabEvents } from "./tab/tab-shared.ts";
export type BotTabOperations = ReturnType<BotTab["operationContext"]>;

import { randomUUID } from "node:crypto";
import { type HostBrowserInputEvent, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { Cdp } from "./cdp.ts";
import type { createBrowserDiagnostics } from "./debug/debug-diagnostics.ts";
import type { createNetworkLog } from "./debug/network-log.ts";
import { ClickCapture } from "./page/click-capture.ts";
import { GUARD_WORLD, RECORD_BINDING, RECORD_SCRIPT, RECORD_WORLD } from "./page/page-scripts.ts";
import type { Mark } from "./page/phases.ts";
import { RefTable } from "./page/snapshot.ts";
import type { BrowserPlatform, BrowserWindow, Rectangle, Session } from "./platform.ts";
import type { BrowserFrame } from "./types.ts";

/**
 * One hidden window per tab: `show:false`, software compositing in the mac owner, CDP
 * control. During a takeover the same window is shown as an ordinary desktop window.
 */
export class BotTab {
  readonly refs = new RefTable();
  readonly clickCapture = new ClickCapture();
  private diagnostics: ReturnType<typeof createBrowserDiagnostics> | undefined;
  private userDiagnostics: ReturnType<typeof createBrowserDiagnostics> | undefined;
  private networkLog: ReturnType<typeof createNetworkLog> | undefined;
  private document = randomUUID();
  viewVersion = 0;
  viewportBusy = false;
  debugSupported = false;
  private frames = new Map<
    number,
    { documentId: string; version: number; at: number; width: number; height: number }
  >();
  get documentId() {
    return this.document;
  }
  readonly registerSecret = (value: string, handle?: string) =>
    this.debugOptions?.registerSecret?.(value, handle);
  readonly redact = (text: string) => this.debugOptions?.redact(text) ?? "[redaction unavailable]";
  invalidateView() {
    this.clickCapture.clear();
    this.viewVersion++;
    this.frames.clear();
  }
  resetDebug(clearDiagnostics = true) {
    this.document = randomUUID();
    this.invalidateView();
    if (clearDiagnostics) {
      this.diagnostics?.reset();
      this.userDiagnostics?.reset();
      this.networkLog?.reset();
    }
  }
  setViewportCapture(active: boolean) {
    this.viewportBusy = active;
    this.invalidateView();
    this.nudgeCast?.(true);
  }
  network(after = 0, limit = 20) {
    if (!this.networkLog)
      throw new RpcError(RpcErrorCodes.unsupported, "browser_network_unsupported");
    return this.networkLog.read(after, limit);
  }
  networkMask() {
    return this.networkLog?.mask;
  }
  debug(after?: number, limit?: number, audience: "agent" | "user" = "agent") {
    const diagnostics = audience === "user" ? this.userDiagnostics : this.diagnostics;
    if (!diagnostics) throw new RpcError(RpcErrorCodes.unsupported, "browser_debug_unsupported");
    return diagnostics.read(after, limit).then((value) => ({
      ...value,
      documentId: this.documentId,
      supported: value.supported && this.debugSupported,
    }));
  }
  markFrame(seq: number, frame: BrowserFrame) {
    if (frame.documentId !== this.documentId) return;
    this.frames.set(seq, {
      documentId: frame.documentId,
      version: frame.version,
      at: Date.now(),
      width: frame.width,
      height: frame.height,
    });
    while (this.frames.size > 2) this.frames.delete(this.frames.keys().next().value as number);
  }
  matchesFrame(point: { documentId: string; frameSeq: number; x: number; y: number }) {
    const frame = this.frames.get(point.frameSeq);
    return (
      this.debugSupported &&
      !!frame &&
      point.documentId === this.documentId &&
      frame.documentId === this.documentId &&
      frame.version === this.viewVersion &&
      point.x >= 0 &&
      point.x < frame.width &&
      point.y >= 0 &&
      point.y < frame.height &&
      !this.loading &&
      !this.viewportBusy
    );
  }
  lastError: string | undefined;
  private window: BrowserWindow | undefined;
  private cdp: Cdp | undefined;
  private recordScript: string | undefined;
  private stopCast: (() => void) | undefined;
  private nudgeCast: ((force?: boolean) => void) | undefined;
  private defaultHeight: number | undefined;
  /** Shown as a takeover window; holds the hidden content size to return to. */
  private presented: { width: number; height: number } | undefined;
  /** Shown at least once (a takeover): hidden size changes then go through redrawHidden. */
  private shownOnce = false;
  /** Hidden resizes / redraws, one at a time (each shows the window transparently). */
  private sizing: Promise<void> = Promise.resolve();
  /** Where the takeover window last was, still known after the page closed it. */
  private lastBounds: Rectangle | undefined;
  /** close() is tearing the window down; its "closed" event is then no news. */
  private closing = false;
  /** A page's popup (adopt): its identity goes through CDP, see adopt(). */
  private popup = false;
  private takeoverToolbar?: {
    present(window: BrowserWindow): void;
    unpresent(): void;
    dispose(): void;
  };
  setTakeoverToolbar(toolbar: NonNullable<BotTab["takeoverToolbar"]>) {
    this.takeoverToolbar?.dispose();
    this.takeoverToolbar = toolbar;
  }
  /** The user agent the current (or loading) document presents. */
  private identity: string;

  constructor(
    private readonly platform: BrowserPlatform,
    readonly id: string,
    private readonly session: Session,
    private readonly userAgent: string,
    private readonly events: TabEvents,
    /** The tab whose page opened this one as a popup (window.opener). */
    readonly openerId?: string,
    private readonly debugOptions?: {
      enabled(): boolean;
      userEnabled?(): boolean;
      redact(text: string): string;
      registerSecret?(value: string, handle?: string): void;
    },
  ) {
    this.identity = userAgent;
  }

  get contents() {
    if (!this.window || this.window.isDestroyed())
      throw new RpcError(RpcErrorCodes.closed, "browser_tab_closed");
    return this.window.webContents;
  }
  get control() {
    if (!this.cdp) throw new RpcError(RpcErrorCodes.closed, "browser_tab_closed");
    return this.cdp;
  }
  get url() {
    return this.window && !this.window.isDestroyed() ? this.contents.getURL() : "";
  }
  get title() {
    return this.window && !this.window.isDestroyed() ? this.contents.getTitle() : "";
  }
  get loading() {
    return !!this.window && !this.window.isDestroyed() && this.contents.isLoading();
  }
  /** What this tab's requests other than page loads say they are. */
  get presentedUserAgent() {
    return this.identity;
  }
  /**
   * The page shows the engine's own client hints: always in a tab (its webContents user agent
   * keeps them, Firefox or not), in a popup only without a CDP override (which replaces them).
   */
  get ownClientHints() {
    return !this.popup || this.identity === this.userAgent;
  }
  get contentsId() {
    return this.window && !this.window.isDestroyed() ? this.window.webContents.id : undefined;
  }

  /**
   * A fresh blank tab. The window exists and its handlers are wired before the first await, so
   * the caller can add its own listeners to `contents` right after calling.
   */
  async open() {
    const contents = this.wire(this.platform.createWindow(tabWindowOptions(this.session)));
    // Commands sent before the first navigation never resolve, so CDP waits for a page.
    await contents.loadURL("about:blank");
    await this.attach();
  }

  /**
   * A page's own popup (window.open allowed by windowOpen), from did-create-window with the
   * address it opens: Electron made the window with the opener relationship, and its first
   * navigation has not started yet. The handlers are wired synchronously, so that navigation
   * already gets the site check (will-navigate fires for it); it has an initial empty document,
   * so CDP attaches without loading anything.
   *
   * Identity: a popup's page-initiated loads never take the webContents user agent (Chromium
   * only applies it to a popup's navigations after a browser-initiated load; measured: every
   * document showed the process fallback, so Google's sign-in in a popup saw a Chromium page
   * behind Firefox headers and refused it). CDP's override does apply, from the first document
   * on and also across a redirect, without the reload that would cut window.opener. So a popup
   * keeps the webContents user agent at the ordinary one and its identity is the CDP override, set
   * first thing here for the address it opens and at each navigation / redirect after.
   */
  async adopt(window: BrowserWindow, url: string) {
    this.popup = true;
    this.identity = this.events.userAgentFor(url);
    this.wire(window);
    await this.attach();
  }

  /** Every handler a tab window needs, fresh or adopted; synchronous on purpose (see adopt). */
  private wire(window: BrowserWindow) {
    return wireStep.call(this.operationContext(), window);
  }

  /** In a popup (adopt): the identity of the document at this address, when it changes. */
  private followIdentity(url: string): void {
    followIdentityStep.call(this.operationContext(), url);
  }

  private sendIdentity(): void {
    sendIdentityStep.call(this.operationContext());
  }

  /** Debugger, guard world and page events; the window already has a document. */
  private attach(): Promise<void> {
    return attachStep.call(this.operationContext());
  }

  /**
   * Waits until the load settles, the deadline passes, or the document has been ready for
   * LOAD_GRACE_MS; callers read `loading` afterwards. Waiting for every subresource made
   * browser_open take the whole 20 s on large pages (the owner's logs and a Wikipedia article
   * over a slow proxy), although the page was readable seconds earlier. `loading: true` tells the
   * model to `browser_wait` for load when it needs the rest.
   */
  async navigate(url: string, timeoutMs = 20_000, mark?: Mark) {
    this.lastError = undefined;
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let readyAt: number | undefined;
    let usable = () => {};
    const ready = new Promise<void>((resolve) => {
      usable = resolve;
    });
    const offDom = this.cdp?.on("Page.domContentEventFired", () => {
      if (readyAt !== undefined) return;
      readyAt = Date.now();
      mark?.("dom_ready");
      grace = setTimeout(usable, LOAD_GRACE_MS);
    });
    // loadURL settles early when a previous load is superseded (ERR_ABORTED) or a request is
    // refused; failures surface through did-fail-load and blocked entries, so only wait here.
    try {
      await Promise.race([
        this.contents.loadURL(url).catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
        ready,
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      offDom?.();
    }
    mark?.("load");
    const until = readyAt === undefined ? deadline : Math.min(deadline, readyAt + LOAD_GRACE_MS);
    await this.settle(0, Math.max(0, until - Date.now()));
    mark?.("settle");
  }

  /**
   * Replaces a blank error page with an explanation. A refused or failed load leaves
   * Chromium's empty error document in that address's history entry; the notice is written into
   * it, so back / forward keep working and the address stays visible. A page that did load (a
   * private peer seen after DNS) is unloaded to about:blank first. The load error the Bot is
   * told about stays as it was.
   */
  async showNotice(html: string) {
    const error = this.lastError;
    await this.settle(0, 5000);
    const cdp = this.control;
    const frame = async () =>
      (await cdp.send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree"))
        .frameTree.frame;
    let current = await frame();
    if (!current.url.startsWith("chrome-error:")) {
      await this.navigate("about:blank", 5000);
      current = await frame();
    }
    this.lastError = error;
    await cdp.send("Page.setDocumentContent", { frameId: current.id, html });
  }

  async settle(startMs = 400, timeoutMs = 10_000) {
    // A click may start navigation a moment later; give it a short chance before measuring.
    if (startMs) await delay(startMs);
    const deadline = Date.now() + timeoutMs;
    while (this.loading && Date.now() < deadline) await delay(100);
  }

  /** Allow form submission in the main frame's guard world until the next document. */
  async setSubmitMode(allow: boolean) {
    const cdp = this.control;
    const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>(
      "Page.getFrameTree",
    );
    const { executionContextId } = await cdp.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: GUARD_WORLD },
    );
    await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `globalThis.__pibotGuard && (globalThis.__pibotGuard.mode = ${JSON.stringify(allow ? "allow" : "block")})`,
    });
  }

  async startRecording() {
    if (this.recordScript) return;
    const cdp = this.control;
    await cdp.send("Runtime.addBinding", {
      name: RECORD_BINDING,
      executionContextName: RECORD_WORLD,
    });
    const { identifier } = await cdp.send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: RECORD_SCRIPT, worldName: RECORD_WORLD, runImmediately: true },
    );
    this.recordScript = identifier;
  }

  async stopRecording() {
    const identifier = this.recordScript;
    if (!identifier || !this.cdp) return;
    this.recordScript = undefined;
    // The installed listeners stay in the current document but the binding they call is gone.
    await this.cdp.send("Runtime.removeBinding", { name: RECORD_BINDING }).catch(() => {});
    await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
  }

  /** Page viewport: the overlay fits the height to its box; width stays desktop-sized. */
  setViewportHeight(height: number | undefined) {
    return setViewportHeightStep.call(this.operationContext(), height);
  }

  /** Content size of the hidden window; see this.platform.drawsOnlyWhenShown for the once-shown case. */
  private resize(width: number, height: number) {
    return resizeStep.call(this.operationContext(), width, height);
  }

  /**
   * Makes a hidden, once-shown window draw again (mac, see this.platform.drawsOnlyWhenShown); the screencast
   * watchdog and a screenshot that got no picture call it. Nothing to do anywhere else.
   */
  repaint() {
    return repaintStep.call(this.operationContext());
  }

  /** One forced redraw after a capture that got no picture (screenshotTab). */
  redrawForCapture() {
    return redrawForCaptureStep.call(this.operationContext());
  }

  /** True while the takeover window shows this page; see screenshotTab for a hidden one. */
  get visibleOnScreen() {
    return !!this.window && !this.window.isDestroyed() && this.window.isVisible();
  }

  private queueRedraw(
    size: { width: number; height: number } | undefined,
    hide?: (window: BrowserWindow) => void,
  ) {
    return queueRedrawStep.call(this.operationContext(), size, hide);
  }

  /** Two animation frames: the page drew at its current size (bounded; a busy page may not). */
  private drawn() {
    return drawnStep.call(this.operationContext());
  }

  /**
   * Overlay frames at most one per `ackMs` (200 ms = 5 frames/s; narrow view 500 ms =
   * 2 frames/s). The stream is pulsed: start, take one frame, stop, wait, start again. A running
   * screencast makes the hidden window composite every frame the page draws, and the owner
   * composites in software, so a 60 Hz animation kept its GPU process at a full core no
   * matter how slowly frames were acked. Between pulses nothing is composited.
   * Each start yields a frame even on a page that did not change, so unchanged frames are not
   * forwarded and the pulses back off to one per second until the page or the user's input
   * changes something. Measured on a packaged build.
   *
   * A start that yields no frame would end the chain for good, so a watchdog redraws and restarts
   * the pulse (a once-shown window resized while hidden had stopped drawing, and
   * the pane froze on the page from before the takeover).
   */
  startScreencast(
    onFrame: (frame: BrowserFrame) => void,
    size: { maxWidth: number; maxHeight: number } = { maxWidth: 1280, maxHeight: 800 },
    quality = 60,
    ackMs = 200,
  ) {
    return startScreencastStep.call(this.operationContext(), onFrame, size, quality, ackMs);
  }

  dispatch(event: HostBrowserInputEvent) {
    return dispatchStep.call(this.operationContext(), event);
  }

  /**
   * Shows the tab as an ordinary, visible, focused desktop window, so the user signs in with
   * a real pointer and keyboard on a page that is visible and focused, as in their own browser.
   * `bounds` keeps the place of the window the user was just in (tab switch); a repeated call
   * only brings the window to the front.
   */
  present(bounds?: Rectangle) {
    return presentStep.call(this.operationContext(), bounds);
  }

  /** Where the takeover window is now, for the next tab's window to take its place. */
  get windowBounds(): Rectangle | undefined {
    if (!this.presented) return undefined;
    return this.window && !this.window.isDestroyed() ? this.window.getBounds() : this.lastBounds;
  }

  /** Back to the hidden background window at its old size. */
  unpresent() {
    return unpresentStep.call(this.operationContext());
  }

  close(): void {
    closeStep.call(this.operationContext());
  }

  // Keep live access to private state: an awaited step must observe later cancellation and scope changes.
  private operationContext() {
    const owner = this;
    return {
      owner,
      get cdp() {
        return owner.cdp;
      },
      set cdp(value: BotTab["cdp"]) {
        owner.cdp = value;
      },
      get closing() {
        return owner.closing;
      },
      set closing(value: BotTab["closing"]) {
        owner.closing = value;
      },
      get contents() {
        return owner.contents;
      },
      get control() {
        return owner.control;
      },
      get debugOptions() {
        return owner.debugOptions;
      },
      get debugSupported() {
        return owner.debugSupported;
      },
      set debugSupported(value: BotTab["debugSupported"]) {
        owner.debugSupported = value;
      },
      get defaultHeight() {
        return owner.defaultHeight;
      },
      set defaultHeight(value: BotTab["defaultHeight"]) {
        owner.defaultHeight = value;
      },
      get diagnostics() {
        return owner.diagnostics;
      },
      set diagnostics(value: BotTab["diagnostics"]) {
        owner.diagnostics = value;
      },
      get documentId() {
        return owner.documentId;
      },
      drawn: owner.drawn.bind(owner),
      get events() {
        return owner.events;
      },
      followIdentity: owner.followIdentity.bind(owner),
      get id() {
        return owner.id;
      },
      get identity() {
        return owner.identity;
      },
      set identity(value: BotTab["identity"]) {
        owner.identity = value;
      },
      invalidateView: owner.invalidateView.bind(owner),
      get lastBounds() {
        return owner.lastBounds;
      },
      set lastBounds(value: BotTab["lastBounds"]) {
        owner.lastBounds = value;
      },
      get lastError() {
        return owner.lastError;
      },
      set lastError(value: BotTab["lastError"]) {
        owner.lastError = value;
      },
      get nudgeCast() {
        return owner.nudgeCast;
      },
      set nudgeCast(value: BotTab["nudgeCast"]) {
        owner.nudgeCast = value;
      },
      get platform() {
        return owner.platform;
      },
      get popup() {
        return owner.popup;
      },
      set popup(value: BotTab["popup"]) {
        owner.popup = value;
      },
      get presented() {
        return owner.presented;
      },
      set presented(value: BotTab["presented"]) {
        owner.presented = value;
      },
      queueRedraw: owner.queueRedraw.bind(owner),
      get redact() {
        return owner.redact;
      },
      get refs() {
        return owner.refs;
      },
      repaint: owner.repaint.bind(owner),
      resetDebug: owner.resetDebug.bind(owner),
      resize: owner.resize.bind(owner),
      sendIdentity: owner.sendIdentity.bind(owner),
      get session() {
        return owner.session;
      },
      get shownOnce() {
        return owner.shownOnce;
      },
      set shownOnce(value: BotTab["shownOnce"]) {
        owner.shownOnce = value;
      },
      get sizing() {
        return owner.sizing;
      },
      set sizing(value: BotTab["sizing"]) {
        owner.sizing = value;
      },
      get stopCast() {
        return owner.stopCast;
      },
      set stopCast(value: BotTab["stopCast"]) {
        owner.stopCast = value;
      },
      get takeoverToolbar() {
        return owner.takeoverToolbar;
      },
      set takeoverToolbar(value: BotTab["takeoverToolbar"]) {
        owner.takeoverToolbar = value;
      },
      get userAgent() {
        return owner.userAgent;
      },
      get networkLog() {
        return owner.networkLog;
      },
      set networkLog(value: BotTab["networkLog"]) {
        owner.networkLog = value;
      },
      get userDiagnostics() {
        return owner.userDiagnostics;
      },
      set userDiagnostics(value: BotTab["userDiagnostics"]) {
        owner.userDiagnostics = value;
      },
      get viewVersion() {
        return owner.viewVersion;
      },
      set viewVersion(value: BotTab["viewVersion"]) {
        owner.viewVersion = value;
      },
      get viewportBusy() {
        return owner.viewportBusy;
      },
      set viewportBusy(value: BotTab["viewportBusy"]) {
        owner.viewportBusy = value;
      },
      get window() {
        return owner.window;
      },
      set window(value: BotTab["window"]) {
        owner.window = value;
      },
    };
  }
}
