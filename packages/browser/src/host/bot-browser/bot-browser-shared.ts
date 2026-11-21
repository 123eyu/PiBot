import { BROWSER_FRAME_FPS, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { BotBrowser } from "../bot-browser.ts";

export const MAX_TABS = 8;

export const MAX_BLOCKED = 50;

export const busy = (message: string) => new RpcError(RpcErrorCodes.busy, message);

/** What a Bot action gets when the user closed the tab it was using. */
export const closedByUser = () =>
  new RpcError(RpcErrorCodes.invalidParams, "browser_tab_closed_by_user");

/** Tab ids are never reused, so a short memory of user-closed ids is enough to name the cause. */
export const MAX_USER_CLOSED = 64;

/** How the Bot browsers of one process share the page limit; see index.ts. */
export interface BrowserPool {
  /** Called right before a Bot with no page opens one; may close another Bot's pages or throw. */
  opening(browser: BotBrowser): void;
  /** The app is quitting: a takeover window must then close instead of going to the background. */
  quitting(): boolean;
}

export const VIEWPORT_WIDTH = 1280;

/** ~1920×1250: keeps a 5 fps JPEG stream within the 512 KB frame cap on busy pages. */
export const FRAME_PIXEL_BUDGET = 2_400_000;

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function fitDisplay(box: { width: number; height: number; scale: number; fps?: number }) {
  const viewportHeight = clamp(Math.round((VIEWPORT_WIDTH * box.height) / box.width), 600, 1600);
  // No more pixels than the box shows (device pixels), never fewer than a readable 640 wide.
  let maxWidth = clamp(Math.round(box.width * box.scale), 640, 2560);
  let maxHeight = Math.round((maxWidth * viewportHeight) / VIEWPORT_WIDTH);
  const over = Math.sqrt((maxWidth * maxHeight) / FRAME_PIXEL_BUDGET);
  if (over > 1) {
    maxWidth = Math.round(maxWidth / over);
    maxHeight = Math.round(maxHeight / over);
  }
  // The ack spacing is the frame-rate cap (CDP sends the next frame only after an ack).
  const ackMs = Math.round(1000 / clamp(box.fps ?? BROWSER_FRAME_FPS, 1, BROWSER_FRAME_FPS));
  return { viewportHeight, maxWidth, maxHeight, ackMs };
}

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
  } catch {
    return "";
  }
};
