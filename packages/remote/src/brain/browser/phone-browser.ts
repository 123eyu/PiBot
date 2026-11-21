import {
  BROWSER_REMOTE_PORT,
  type BrowserRemotePort,
  type BrowserRemoteTarget,
} from "@pibot/browser-contract";
import {
  type BrowserInputEvent,
  browserProfileKey,
  type MethodParams,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { RemoteBrowserInput } from "@pibot/remote-contract";

/**
 * No phone browser call for this long while watching or holding a takeover: the phone froze or
 * vanished without the relay noticing yet, so the Bot gets its browser back.
 */
const LEASE_MS = 30_000;
/** Frames a tap may still refer to; older taps were aimed at a page that has moved on. */
const FRAMES_KEPT = 4;
const POINT_MAX = 16_384;

interface FrameMeta {
  tabId: string;
  width: number;
  height: number;
}
interface Viewed {
  target: BrowserRemoteTarget;
  frames: Map<number, FrameMeta>;
  /** This phone holds the takeover (as far as the last answer from the computer said). */
  owned: boolean;
}
type BrowserMethod =
  | "remote.browser.frame"
  | "remote.browser.stop"
  | "remote.browser.takeover"
  | "remote.browser.input"
  | "remote.browser.navigate";
export const isPhoneBrowserMethod = (method: string): method is BrowserMethod =>
  method.startsWith("remote.browser.");

const target = (input: { botId: string; groupId?: string }): BrowserRemoteTarget => ({
  botId: input.botId,
  ...(input.groupId ? { groupId: input.groupId } : {}),
});
const point = (fraction: number, size: number) => Math.max(0, Math.min(POINT_MAX, fraction * size));

/** Phone gestures → the overlay's input events, in the page CSS pixels of the frame tapped. */
function pageEvents(input: RemoteBrowserInput, frame: FrameMeta): BrowserInputEvent[] {
  switch (input.type) {
    case "tap": {
      const at = { x: point(input.x, frame.width), y: point(input.y, frame.height) };
      // The move first: menus and buttons that react to hover see the pointer arrive.
      return [
        { type: "mouse", action: "move", ...at, button: "none", clickCount: 0, modifiers: 0 },
        { type: "mouse", action: "down", ...at, button: "left", clickCount: 1, modifiers: 0 },
        { type: "mouse", action: "up", ...at, button: "left", clickCount: 1, modifiers: 0 },
      ];
    }
    case "scroll":
      return [
        {
          type: "wheel",
          x: point(input.x, frame.width),
          y: point(input.y, frame.height),
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: 0,
        },
      ];
    case "text":
      return [{ type: "text", text: input.text }];
    case "key":
      return [
        { type: "key", action: "down", key: input.key, code: input.key, modifiers: 0 },
        { type: "key", action: "up", key: input.key, code: input.key, modifiers: 0 },
      ];
  }
}

/**
 * One phone session's use of the computer's Bot browser. Frames are pulled one at a
 * time, so the relay never holds more than the frame being sent. Taps arrive as fractions of a
 * frame and are mapped here to that frame's page coordinates. Any takeover this phone holds is
 * handed back when the phone leaves the view, goes to the background, disconnects or goes quiet.
 */
export class PhoneBrowser {
  private readonly views = new Map<string, Viewed>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly deps: {
      deviceId: string;
      ports: { get<T>(name: string): T | undefined };
      /** `remote.request` audit row (actor phone + device id); never carries page content. */
      audit(method: string, outcome: string): void;
      warn(message: string): void;
    },
  ) {}

  handle(method: BrowserMethod, input: unknown, signal: AbortSignal) {
    switch (method) {
      case "remote.browser.frame":
        return this.frame(input as MethodParams["remote.browser.frame"], signal);
      case "remote.browser.stop":
        return this.stop(input as MethodParams["remote.browser.stop"]);
      case "remote.browser.takeover":
        return this.takeover(input as MethodParams["remote.browser.takeover"]);
      case "remote.browser.input":
        return this.input(input as MethodParams["remote.browser.input"]);
      case "remote.browser.navigate":
        return this.navigate(input as MethodParams["remote.browser.navigate"]);
    }
  }

  private port() {
    const port = this.deps.ports.get<BrowserRemotePort>(BROWSER_REMOTE_PORT);
    if (!port || this.closed) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    return port;
  }
  private get actor() {
    return { deviceId: this.deps.deviceId };
  }
  private view(input: { botId: string; groupId?: string }) {
    const key = browserProfileKey(input.botId, input.groupId);
    let view = this.views.get(key);
    if (!view) {
      view = { target: target(input), frames: new Map(), owned: false };
      this.views.set(key, view);
      this.deps.audit("remote.browser.view", "started");
    }
    this.renew();
    return { key, view };
  }
  private renew() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.views.size && !this.closed)
      this.timer = setTimeout(() => void this.release("timeout"), LEASE_MS);
  }

  private async frame(input: MethodParams["remote.browser.frame"], signal: AbortSignal) {
    const { view } = this.view(input);
    const result = await this.port().frame(view.target, input.after, signal, this.actor);
    if (result.frame) {
      view.frames.set(result.frame.seq, {
        tabId: result.frame.tabId,
        width: result.frame.width,
        height: result.frame.height,
      });
      for (const seq of view.frames.keys()) {
        if (view.frames.size <= FRAMES_KEPT) break;
        view.frames.delete(seq);
      }
    }
    // Handed back on the computer, taken by the desktop user, or the pages closed.
    if (!result.mine) view.owned = false;
    this.renew();
    return result;
  }

  private async stop(input: MethodParams["remote.browser.stop"]) {
    const key = browserProfileKey(input.botId, input.groupId);
    const view = this.views.get(key);
    if (view) await this.end(key, view, "ended");
    return { ok: true as const };
  }

  private async takeover(input: MethodParams["remote.browser.takeover"]) {
    const { key, view } = this.view(input);
    const state = await this.port().takeover(
      {
        ...view.target,
        on: input.on,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      },
      this.actor,
    );
    view.owned = input.on && state.takeover;
    // The phone left (background, disconnect) while the takeover was starting: give it back.
    if (view.owned && (this.closed || this.views.get(key) !== view))
      await this.handBack(view).catch(() => this.deps.warn("Remote browser hand-back unavailable"));
    return state;
  }

  private async input(input: MethodParams["remote.browser.input"]) {
    const key = browserProfileKey(input.botId, input.groupId);
    const view = this.views.get(key);
    const frame = view?.frames.get(input.seq);
    // A tap aimed at a frame of another tab (or one long gone) would land on the wrong page.
    if (!view || !frame || frame.tabId !== input.tabId)
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_frame_stale");
    this.renew();
    const port = this.port();
    for (const event of pageEvents(input.event, frame))
      await port.input({ ...view.target, tabId: input.tabId, event }, this.actor);
    return { ok: true as const };
  }

  private async navigate(input: MethodParams["remote.browser.navigate"]) {
    const { view } = this.view(input);
    return this.port().navigate(
      {
        ...view.target,
        tabId: input.tabId,
        action: input.action,
        ...(input.url ? { url: input.url } : {}),
      },
      this.actor,
    );
  }

  private async handBack(view: Viewed) {
    view.owned = false;
    await this.deps.ports
      .get<BrowserRemotePort>(BROWSER_REMOTE_PORT)
      ?.takeover({ ...view.target, on: false }, this.actor);
  }

  private async end(key: string, view: Viewed, outcome: string) {
    if (this.views.get(key) === view) this.views.delete(key);
    const port = this.deps.ports.get<BrowserRemotePort>(BROWSER_REMOTE_PORT);
    const settled = await Promise.allSettled([
      // Busy = the desktop user stepped in and holds it now; nothing of ours to give back.
      ...(view.owned
        ? [
            this.handBack(view).catch((error: unknown) => {
              if (!(error instanceof RpcError && error.code === RpcErrorCodes.busy)) throw error;
            }),
          ]
        : []),
      ...(port ? [port.stop(view.target)] : []),
    ]);
    if (settled.some((result) => result.status === "rejected"))
      this.deps.warn("Remote browser hand-back unavailable");
    this.deps.audit("remote.browser.view", outcome);
    this.renew();
  }

  /** The phone went to the background, went quiet or the session is closing. */
  async release(reason: "background" | "offline" | "timeout" | "closed") {
    await Promise.all([...this.views].map(([key, view]) => this.end(key, view, reason)));
  }

  async close() {
    await this.release("closed");
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
