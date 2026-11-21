import type { HostBrowserInputEvent } from "@pibot/browser-contract/full";
import type { BrowserWindow, Rectangle } from "../platform.ts";
import type { BotTabOperations } from "../tab.ts";
import type { BrowserFrame } from "../types.ts";
import { MOUSE, pick } from "./tab-shared.ts";

/** Page viewport: the overlay fits the height to its box; width stays desktop-sized. */
export function setViewportHeightStep(this: BotTabOperations, height: number | undefined) {
  // The takeover window is sized by the user; the hidden size comes back on unpresent().
  if (!this.window || this.window.isDestroyed() || this.presented) return;
  const [width = 1280, current = 0] = this.window.getContentSize();
  this.defaultHeight ??= current;
  const next = height ?? this.defaultHeight;
  if (next !== current) this.resize(width, next);
}

/** Content size of the hidden window; see this.platform.drawsOnlyWhenShown for the once-shown case. */
export function resizeStep(this: BotTabOperations, width: number, height: number) {
  const window = this.window;
  if (!window || window.isDestroyed()) return;
  if (!this.platform.drawsOnlyWhenShown || !this.shownOnce) {
    this.invalidateView();
    window.setContentSize(width, height);
    return;
  }
  this.queueRedraw({ width, height });
}

/**
 * Makes a hidden, once-shown window draw again (mac, see this.platform.drawsOnlyWhenShown); the screencast
 * watchdog and a screenshot that got no picture call it. Nothing to do anywhere else.
 */
export function repaintStep(this: BotTabOperations) {
  if (this.platform.drawsOnlyWhenShown && this.shownOnce) this.queueRedraw(undefined);
  return this.sizing;
}

/**
 * One recovery after a capture that got no picture. On mac a hidden window may stop
 * compositing for good, so it is ordered in transparent and click-through once (as a hand-back
 * does) and is then treated as once-shown, which keeps later hidden resizes on the redraw path.
 * Windows / Linux composite hidden windows; there one requested frame is enough, and Linux could
 * not hide a transparent window anyway (no opacity support).
 */
export async function redrawForCaptureStep(this: BotTabOperations) {
  const window = this.window;
  if (!window || window.isDestroyed()) return;
  if (this.platform.drawsOnlyWhenShown && !window.isVisible()) {
    this.shownOnce = true;
    await this.queueRedraw(undefined);
    return;
  }
  this.contents.invalidate();
  await this.drawn();
}

export function queueRedrawStep(
  this: BotTabOperations,
  size: { width: number; height: number } | undefined,
  hide?: (window: BrowserWindow) => void,
) {
  this.sizing = this.sizing
    .then(async () => {
      const window = this.window;
      if (!window || window.isDestroyed() || this.presented) return;
      const [width, height] = window.getContentSize();
      // An earlier call already reached this size (unpresent, then the overlay's own height).
      if (size && width === size.width && height === size.height) {
        if (!hide) return;
        size = undefined;
      }
      // A repaint of a window on screen (not handed back yet) has nothing to do.
      if (!size && !hide && window.isVisible()) return;
      await this.platform.redrawHidden(window, {
        ...(size ? { size } : {}),
        drawn: () => this.drawn(),
        keep: () => !!this.presented,
        hide: () => (hide ? hide(window) : window.hide()),
      });
    })
    .catch(() => {
      // Only a window destroyed mid-redraw throws here; a closed tab has nothing left to size.
    });
  return this.sizing;
}

/** Two animation frames: the page drew at its current size (bounded; a busy page may not). */
export function drawnStep(this: BotTabOperations) {
  const cdp = this.cdp;
  if (!cdp) return Promise.resolve();
  return cdp
    .send(
      "Runtime.evaluate",
      {
        expression:
          "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))",
        awaitPromise: true,
      },
      1000,
    )
    .catch(() => {
      // Timed out or navigated away: the window is hidden again either way.
    });
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
export function startScreencastStep(
  this: BotTabOperations,
  onFrame: (frame: BrowserFrame) => void,
  size: { maxWidth: number; maxHeight: number } = { maxWidth: 1280, maxHeight: 800 },
  quality = 60,
  ackMs = 200,
) {
  this.stopCast?.();
  const cdp = this.control;
  let live = true;
  let waiting = false;
  let pulseAt = 0;
  let pulseDocument = this.documentId;
  let pulseVersion = this.viewVersion;
  let unchanged = 0;
  let last: Buffer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let misses = 0;
  const pulse = (first = false) => {
    clearTimeout(timer);
    timer = undefined;
    clearTimeout(watchdog);
    if (!live || this.viewportBusy) {
      void cdp.send("Page.stopScreencast").catch(() => {});
      return;
    }
    waiting = false;
    pulseAt = performance.now();
    pulseDocument = this.documentId;
    pulseVersion = this.viewVersion;
    // 1.5 s covers a slow first paint; a page that stays silent is retried less and less often.
    watchdog = setTimeout(missed, Math.min(1500 * 2 ** misses, 12_000));
    void cdp
      .send("Page.startScreencast", { format: "jpeg", quality, ...size })
      // A (re)opened stream on a static page would otherwise wait for the page to draw.
      .then(
        () => first && live && this.window?.isDestroyed() === false && this.contents.invalidate(),
      )
      .catch(() => {});
  };
  const missed = () => {
    if (!live || waiting) return;
    misses++;
    void cdp.send("Page.stopScreencast").catch(() => {});
    // The first miss of a stall redraws a once-shown hidden window (mac); every miss asks the
    // page for a new frame before the next start.
    const redraw = misses === 1 ? this.repaint() : Promise.resolve();
    void redraw.then(() => {
      if (!live || waiting) return;
      if (this.window?.isDestroyed() === false) this.contents.invalidate();
      pulse();
    });
  };
  const off = cdp.on("Page.screencastFrame", (params) => {
    // Even discarded frames hold a Chromium screencast slot until acknowledged.
    void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (!live || waiting || this.viewportBusy) return;
    waiting = true;
    misses = 0;
    clearTimeout(watchdog);
    void cdp.send("Page.stopScreencast").catch(() => {});
    if (pulseDocument !== this.documentId || pulseVersion !== this.viewVersion) {
      timer = setTimeout(() => pulse(true), ackMs);
      return;
    }
    const meta = params.metadata as {
      deviceWidth: number;
      deviceHeight: number;
      pageScaleFactor: number;
      scrollOffsetX: number;
      scrollOffsetY: number;
    };
    const data = Buffer.from(String(params.data), "base64");
    if (last?.equals(data)) unchanged++;
    else {
      unchanged = 0;
      last = data;
      onFrame({
        tab: this.id,
        documentId: this.documentId,
        version: this.viewVersion,
        data,
        width: meta.deviceWidth,
        height: meta.deviceHeight,
        scale: meta.pageScaleFactor || 1,
        scrollX: meta.scrollOffsetX,
        scrollY: meta.scrollOffsetY,
      });
    }
    // Due ackMs after this pulse started (start-to-frame latency does not lower the rate);
    // doubled per unchanged frame, at most one pulse a second.
    const interval = Math.min(ackMs * 2 ** Math.min(unchanged, 3), Math.max(ackMs, 1000));
    timer = setTimeout(() => pulse(), Math.max(0, pulseAt + interval - performance.now()));
  });
  pulse(true);
  // The user's own input in a takeover should show without the backed-off wait.
  this.nudgeCast = (force = false) => {
    if (live && (force || (unchanged > 0 && timer))) {
      unchanged = 0;
      if (force) {
        last = undefined;
        misses = 0;
      }
      pulse(true);
    }
  };
  const stop = () => {
    if (this.stopCast !== stop) return;
    this.stopCast = undefined;
    this.nudgeCast = undefined;
    live = false;
    off();
    clearTimeout(timer);
    clearTimeout(watchdog);
    void cdp.send("Page.stopScreencast").catch(() => {});
  };
  this.stopCast = stop;
  return stop;
}

export async function dispatchStep(this: BotTabOperations, event: HostBrowserInputEvent) {
  const cdp = this.control;
  this.nudgeCast?.();
  if (event.type === "text") await cdp.send("Input.insertText", { text: event.text });
  else if (event.type === "wheel")
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...pick(event, ["x", "y", "deltaX", "deltaY"]),
    });
  else if (event.type === "mouse")
    await cdp.send("Input.dispatchMouseEvent", {
      type: MOUSE[event.action],
      x: event.x,
      y: event.y,
      button: event.button ?? (event.action === "move" ? "none" : "left"),
      clickCount: event.clickCount ?? (event.action === "move" ? 0 : 1),
      modifiers: event.modifiers ?? 0,
    });
  else
    await cdp.send("Input.dispatchKeyEvent", {
      type: event.action === "up" ? "keyUp" : event.text ? "keyDown" : "rawKeyDown",
      key: event.key,
      code: event.code,
      ...(event.text ? { text: event.text } : {}),
      ...(event.keyCode !== undefined ? { windowsVirtualKeyCode: event.keyCode } : {}),
      modifiers: event.modifiers ?? 0,
    });
}

/**
 * Shows the tab as an ordinary, visible, focused desktop window, so the user signs in with
 * a real pointer and keyboard on a page that is visible and focused, as in their own browser.
 * `bounds` keeps the place of the window the user was just in (tab switch); a repeated call
 * only brings the window to the front.
 */
export function presentStep(this: BotTabOperations, bounds?: Rectangle) {
  const window = this.window;
  if (!window || window.isDestroyed()) return;
  if (!this.presented) {
    const [width = 1280, height = 800] = window.getContentSize();
    this.presented = { width, height };
    this.shownOnce = true;
    this.invalidateView();
    window.setBounds(bounds ?? this.platform.takeoverBounds());
    this.lastBounds = window.getBounds();
  }
  this.platform.bringToFront(window);
  this.takeoverToolbar?.present(window);
}

/** Back to the hidden background window at its old size. */
export function unpresentStep(this: BotTabOperations) {
  const window = this.window;
  const restore = this.presented;
  this.presented = undefined;
  this.takeoverToolbar?.unpresent();
  this.invalidateView();
  if (!restore || !window || window.isDestroyed()) return;
  if (this.platform.drawsOnlyWhenShown) {
    // Resized after hide() it would stop drawing; so back to the hidden size while still
    // ordered in (transparent from now on), then hidden.
    this.queueRedraw(restore, (window) => this.platform.sendToBack(window));
    return;
  }
  this.platform.sendToBack(window);
  window.setContentSize(restore.width, restore.height);
}
