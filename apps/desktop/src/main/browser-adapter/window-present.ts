import { app, BrowserWindow, Menu, type Rectangle, screen } from "electron";

// A taken-over tab is shown as an ordinary desktop window. Everything that differs
// per platform about that window lives here.

/** Applied to every tab window once, while it is still hidden. */
export function prepareTabWindow(window: BrowserWindow) {
  // Windows / Linux: the default menu bar (and its Ctrl+Q / Ctrl+W accelerators) does not belong
  // on a page window; clipboard and editing keys work without it. macOS has no per-window menu.
  if (process.platform !== "darwin") window.removeMenu();
}

/** A desktop-sized window on the display the user is working on (where the pointer is). */
export function takeoverBounds(): Rectangle {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1280, Math.max(640, area.width - 64));
  const height = Math.min(900, Math.max(480, area.height - 64));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/** Shows the window in front with keyboard focus, like a browser window the user opened. */
export function bringToFront(window: BrowserWindow) {
  if (process.platform === "darwin") {
    // The mac owner is a background (accessory) app: without activating it, its window opens
    // behind the app the user is in. Its key equivalents go through the application menu, so it
    // needs editing items for copy / paste, and no Quit: Cmd+Q here would stop the whole owner.
    Menu.setApplicationMenu(MAC_MENU());
    app.focus({ steal: true });
  }
  window.show();
  window.focus();
}

/**
 * mac: a tab window that was shown once (a takeover) stops drawing for good when its size changes
 * while it is hidden again: no animation frames, no screencast frames, captureScreenshot never
 * returns (measured with GPU and software compositing alike; `hide()` alone is
 * enough, a never-shown window resizes fine, and showing it again recovers). Such a window is
 * therefore resized, or just redrawn, while ordered in fully transparent and click-through.
 * Windows / Linux were not measured to need it.
 */
export const drawsOnlyWhenShown = process.platform === "darwin";

/**
 * Orders a once-shown window in (or keeps the just handed-back one there) with nothing visible or
 * clickable, applies `size`, waits until the page drew (`drawn`, bounded by its caller) and hides
 * it with `hide`. `keep()` true at the end means the window was presented meanwhile: it stays.
 */
export async function redrawHidden(
  window: BrowserWindow,
  options: {
    size?: { width: number; height: number };
    drawn(): Promise<unknown>;
    keep(): boolean;
    hide(): void;
  },
) {
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  try {
    // Never activates the owner, so the keyboard stays with the app the user is in.
    if (!window.isVisible()) window.showInactive();
    if (options.size) window.setContentSize(options.size.width, options.size.height);
    await options.drawn();
  } finally {
    if (!window.isDestroyed()) {
      if (!options.keep()) options.hide();
      window.setIgnoreMouseEvents(false);
      window.setOpacity(1);
    }
  }
}

/** Hides the window again (back to a background tab). */
export function sendToBack(window: BrowserWindow) {
  window.hide();
  // mac: the owner stays the active app with no window left, so the keyboard would go nowhere;
  // handing activation back returns it to the app the user was in before (usually Pi Bot).
  if (
    process.platform === "darwin" &&
    !BrowserWindow.getAllWindows().some((other) => other.isVisible())
  )
    app.hide();
}

// Built on use: the menu is never displayed (accessory apps have no menu bar), only its keys
// matter, so the role items carry their own labels.
const MAC_MENU = () =>
  Menu.buildFromTemplate([
    { role: "appMenu", submenu: [{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }] },
    { role: "editMenu" },
    { role: "windowMenu", submenu: [{ role: "minimize" }, { role: "close" }] },
  ]);
