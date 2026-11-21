import type { RemoteBrowserInput } from "@pibot/protocol";
import type { Caller } from "../chat/controls/scope.ts";

// Plain RPC sequences behind the phone's Bot browser view. The hook adds state and
// cancellation; the dev scenario calls these directly to list the methods the view uses.

export interface BrowserTarget {
  botId: string;
  groupId?: string;
}
/** Frame requests wait on the computer for a new frame (about 4 s) before answering "none". */
const FRAME_TIMEOUT_MS = 15_000;

export function readBrowserTabs(c: Caller, target: BrowserTarget, signal?: AbortSignal) {
  return c.call("browser.tabs", target, signal);
}
/** The next frame newer than `after`; asking again is what lets the computer send another. */
export function nextFrame(c: Caller, target: BrowserTarget, after: number, signal?: AbortSignal) {
  return c.call("remote.browser.frame", { ...target, after }, signal, FRAME_TIMEOUT_MS);
}
export function stopWatching(c: Caller, target: BrowserTarget, signal?: AbortSignal) {
  return c.call("remote.browser.stop", target, signal);
}
export function setTakeover(
  c: Caller,
  target: BrowserTarget,
  on: boolean,
  conversationId: string | undefined,
  signal?: AbortSignal,
) {
  return c.call(
    "remote.browser.takeover",
    { ...target, on, ...(conversationId ? { conversationId } : {}) },
    signal,
    // Taking over sleeping pages reopens them first.
    60_000,
  );
}
export function sendInput(
  c: Caller,
  target: BrowserTarget,
  frame: { seq: number; tabId: string },
  event: RemoteBrowserInput,
  signal?: AbortSignal,
) {
  return c.call(
    "remote.browser.input",
    { ...target, tabId: frame.tabId, seq: frame.seq, event },
    signal,
  );
}
export function navigate(
  c: Caller,
  target: BrowserTarget,
  tabId: string,
  action: "url" | "back" | "forward" | "reload",
  url: string | undefined,
  signal?: AbortSignal,
) {
  return c.call(
    "remote.browser.navigate",
    { ...target, tabId, action, ...(url ? { url } : {}) },
    signal,
  );
}
