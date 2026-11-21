import type { BrowserInputEvent, BrowserState } from "@pibot/protocol-base";

/**
 * What the browser capability offers the phone remote (looked up through
 * `CapabilityContext.ports` under this name). The phone never opens pages itself; it watches and
 * drives the computer's Bot browser through the same view service the desktop overlay uses, so
 * host rules (private addresses, only-listed sites) and the Bot's pause during takeover still apply.
 */
export const BROWSER_REMOTE_PORT = "browser.remote";

/** Who drives a phone takeover; recorded on the takeover audit row. */
export interface BrowserRemoteActor {
  deviceId: string;
}
export interface BrowserRemoteTarget {
  botId: string;
  groupId?: string;
}
export interface BrowserRemoteFrame {
  seq: number;
  tabId: string;
  /** Page CSS pixels the frame covers; input points are mapped into this space. */
  width: number;
  height: number;
  /** JPEG, base64. */
  data: string;
}
export interface BrowserRemoteView {
  state: BrowserState;
  frame: BrowserRemoteFrame | null;
  /** This phone holds the takeover (false when the desktop user or another phone does). */
  mine: boolean;
}
export interface BrowserRemotePort {
  /** Next frame newer than `after` (at most 2 per second), or none once the wait runs out. */
  frame(
    target: BrowserRemoteTarget,
    after: number,
    signal: AbortSignal,
    actor: BrowserRemoteActor,
  ): Promise<BrowserRemoteView>;
  /** The phone stopped watching this Bot's browser. */
  stop(target: BrowserRemoteTarget): Promise<void>;
  /**
   * Starts or ends a takeover owned by this phone. Refused (busy) while the desktop, another phone
   * or a teaching recording holds the browser; a phone can only hand back its own takeover.
   */
  takeover(
    target: BrowserRemoteTarget & { on: boolean; conversationId?: string },
    actor: BrowserRemoteActor,
  ): Promise<BrowserState>;
  /** Input in page CSS pixels; only during this phone's own takeover. */
  input(
    target: BrowserRemoteTarget & { tabId: string; event: BrowserInputEvent },
    actor: BrowserRemoteActor,
  ): Promise<void>;
  /** Address bar, back, forward, reload; only during this phone's own takeover. */
  navigate(
    target: BrowserRemoteTarget & {
      tabId: string;
      action: "url" | "back" | "forward" | "reload";
      url?: string;
    },
    actor: BrowserRemoteActor,
  ): Promise<BrowserState>;
}
