import {
  BROWSER_FRAME_IN_FLIGHT,
  BROWSER_FRAME_MAX_BYTES,
  BROWSER_REMOTE_FRAME_INTERVAL_MS,
  type BrowserFrameMessage,
  type BrowserTab,
  type BrowserViewDisplay,
  browserProfileKey,
  type HostBrowserRemoteFrame,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import type { Logger } from "@pibot/observability";
import type { BotBrowser, BotBrowsers, BrowserFrame } from "../index.ts";

/**
 * Where overlay frames go. Windows / Linux: straight to the window in this process.
 * macOS owner: over the authenticated socket to the GUI main, which forwards to its window.
 * Either way frames never enter the business RPC queue.
 */
export interface BrowserFrameTransport {
  /** False when no window can take frames now; the stream then stops instead of queueing. */
  send(message: BrowserFrameMessage): boolean;
  onAck(listener: (botId: string, seq: number, groupId?: string) => void): () => void;
}

/** No ack for this long while the window owes acks: it is gone or frozen, so stop. */
const STALL_MS = 15_000;
const TABS_POLL_MS = 1000;
/**
 * A phone viewer that has not asked for a frame this long is gone (left the view, lost
 * the relay, went to the background without saying so); its share of the screencast stops.
 */
const REMOTE_LEASE_MS = 10_000;

interface Stream {
  browser: BotBrowser;
  stop(): void;
  seq: number;
  inFlight: Set<number>;
  dropped: number;
  ackedAt: number;
  tabsKey: string;
  timer: ReturnType<typeof setInterval>;
}
/** One screencast per Bot browser, shared by the overlay window and phone viewers. */
interface Cast {
  browser: BotBrowser;
  listeners: Set<(frame: BrowserFrame) => void>;
  stop(): void;
}
/** The phone's pull-based view of one Bot browser (newest frame only, never a queue). */
interface RemoteViewer {
  browser: BotBrowser;
  unsubscribe(): void;
  seq: number;
  latest?: HostBrowserRemoteFrame;
  servedAt: number;
  servedSeq: number;
  waiters: Set<() => void>;
  lease: ReturnType<typeof setTimeout>;
  dropped: number;
}

const plain = (value: string, max: number) =>
  [...value]
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("")
    .slice(0, max);
/** Log label only: a group Bot's key carries the group id, which logs need not repeat. */
const scopeLabel = (key: string) => (key.startsWith("group:") ? "group" : "bot");

/** UI tab rows; the host tab id (`t<n>`) is already a valid UI tab id. */
export function uiTabs(browser: BotBrowser): BrowserTab[] {
  return browser.viewTabs().map((tab) => ({
    id: tab.tab,
    url: plain(tab.url, 2048),
    title: plain(tab.title, 500),
    active: tab.active,
    loading: tab.loading,
    ...("error" in tab && tab.error ? { error: tab.error } : {}),
  }));
}

/**
 * Overlay frame pump for the Bot browsers of one brain host. Holds at most
 * `BROWSER_FRAME_IN_FLIGHT` unacknowledged frames per Bot (newer frames are dropped while the
 * window is behind; the kernel already paces CDP to one frame per 200 ms). Also serves the phone
 * viewers from the same screencast. Created and disposed with the brain host that owns
 * `browsers`.
 */
export function createBrowserFrames(options: {
  browsers: BotBrowsers;
  transport: BrowserFrameTransport | undefined;
  logger: Pick<Logger, "info" | "warn">;
}) {
  const streams = new Map<string, Stream>();
  const casts = new Map<string, Cast>();
  const remotes = new Map<string, RemoteViewer>();
  /**
   * BotBrowser keeps a single screencast; a second startScreencast would cut the first one off,
   * so the window stream and phone viewers subscribe here and the cast stops with the last one.
   */
  const subscribe = (key: string, browser: BotBrowser, listener: (frame: BrowserFrame) => void) => {
    let cast = casts.get(key);
    if (cast && cast.browser !== browser) {
      casts.delete(key);
      cast.stop();
      cast = undefined;
    }
    if (!cast) {
      const created: Cast = { browser, listeners: new Set(), stop: () => {} };
      casts.set(key, created);
      created.stop = browser.startScreencast((frame) => {
        for (const each of [...created.listeners]) each(frame);
      });
      cast = created;
    }
    const current = cast;
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size || casts.get(key) !== current) return;
      casts.delete(key);
      current.stop();
    };
  };
  const end = (botId: string, reason: "hidden" | "closed" | "idle" | "error") => {
    const stream = streams.get(botId);
    if (!stream) return;
    streams.delete(botId);
    clearInterval(stream.timer);
    stream.stop();
    // A phone still watching keeps the cast; the page goes back to the default viewport the
    // overlay had fitted it away from (the cast's own stop does this when it is the last one).
    if (casts.get(botId)?.browser === stream.browser && stream.browser.open)
      stream.browser.setDisplay(undefined);
    options.transport?.send({
      type: "end",
      botId: stream.browser.botId,
      ...(stream.browser.groupId ? { groupId: stream.browser.groupId } : {}),
      reason,
    });
    options.logger.info(
      `browser.view.end botId=${botId} reason=${reason} frames=${stream.seq} dropped=${stream.dropped}`,
    );
  };
  const sendTabs = (botId: string, stream: Stream) => {
    const tabs = uiTabs(stream.browser);
    const key = JSON.stringify([tabs, stream.browser.takeover]);
    if (key === stream.tabsKey) return;
    stream.tabsKey = key;
    if (
      !options.transport?.send({
        type: "tabs",
        botId: stream.browser.botId,
        ...(stream.browser.groupId ? { groupId: stream.browser.groupId } : {}),
        tabs,
        takeover: stream.browser.takeover,
      })
    )
      end(botId, "closed");
  };
  const offAck = options.transport?.onAck((botId, seq, groupId) => {
    const stream = streams.get(browserProfileKey(botId, groupId));
    if (!stream) return;
    // Acks arrive in order; one ack also settles anything older the window skipped.
    for (const pending of stream.inFlight) if (pending <= seq) stream.inFlight.delete(pending);
    stream.ackedAt = performance.now();
  });
  const start = (botId: string, browser: BotBrowser) => {
    const transport = options.transport;
    if (!transport) throw new RpcError(RpcErrorCodes.unsupported, "browser_view_unavailable");
    let stream: Stream | undefined;
    const onFrame = (frame: BrowserFrame) => {
      if (!stream || streams.get(botId) !== stream) return;
      if (stream.inFlight.size >= BROWSER_FRAME_IN_FLIGHT || frame.data.byteLength === 0) {
        stream.dropped++;
        return;
      }
      if (frame.data.byteLength > BROWSER_FRAME_MAX_BYTES) {
        stream.dropped++;
        return;
      }
      const seq = ++stream.seq;
      stream.inFlight.add(seq);
      browser.tab(frame.tab).markFrame(seq, frame);
      const sent = transport.send({
        type: "frame",
        botId: browser.botId,
        ...(browser.groupId ? { groupId: browser.groupId } : {}),
        tabId: frame.tab,
        documentId: frame.documentId,
        seq,
        mimeType: "image/jpeg",
        width: Math.max(1, Math.min(8192, Math.round(frame.width))),
        height: Math.max(1, Math.min(8192, Math.round(frame.height))),
        // A copy, so structured cloning never drags along a larger pooled buffer.
        data: new Uint8Array(frame.data),
      });
      if (!sent) end(botId, "closed");
    };
    const timer = setInterval(() => {
      const current = streams.get(botId);
      if (!current) return;
      // closeAll() (brain child gone) disposes the instance; the overlay asks again later.
      if (options.browsers.find(browser.botId, browser.groupId) !== current.browser) {
        end(botId, "closed");
        return;
      }
      if (
        current.inFlight.size >= BROWSER_FRAME_IN_FLIGHT &&
        performance.now() - current.ackedAt > STALL_MS
      ) {
        end(botId, "idle");
        return;
      }
      sendTabs(botId, current);
    }, TABS_POLL_MS);
    stream = {
      browser,
      stop: () => {},
      seq: 0,
      inFlight: new Set(),
      dropped: 0,
      ackedAt: performance.now(),
      tabsKey: "",
      timer,
    };
    streams.set(botId, stream);
    stream.stop = subscribe(botId, browser, onFrame);
    sendTabs(botId, stream);
    options.logger.info(`browser.view.start botId=${botId}`);
  };
  const endRemote = (key: string) => {
    const viewer = remotes.get(key);
    if (!viewer) return;
    remotes.delete(key);
    clearTimeout(viewer.lease);
    viewer.unsubscribe();
    for (const wake of [...viewer.waiters]) wake();
    options.logger.info(
      `browser.remote.end scope=${scopeLabel(key)} frames=${viewer.seq} dropped=${viewer.dropped}`,
    );
  };
  const renew = (key: string, viewer: RemoteViewer) => {
    clearTimeout(viewer.lease);
    viewer.lease = setTimeout(() => endRemote(key), REMOTE_LEASE_MS);
  };
  const startRemote = (key: string, browser: BotBrowser) => {
    const viewer: RemoteViewer = {
      browser,
      unsubscribe: () => {},
      seq: 0,
      servedAt: 0,
      servedSeq: 0,
      waiters: new Set(),
      lease: setTimeout(() => endRemote(key), REMOTE_LEASE_MS),
      dropped: 0,
    };
    remotes.set(key, viewer);
    viewer.unsubscribe = subscribe(key, browser, (frame) => {
      if (remotes.get(key) !== viewer) return;
      // Over the overlay's own cap a frame would not fit one encrypted relay message either.
      if (frame.data.byteLength === 0 || frame.data.byteLength > BROWSER_FRAME_MAX_BYTES) {
        viewer.dropped++;
        return;
      }
      // Only the newest frame is kept: a phone that is behind skips frames, nothing piles up.
      if (viewer.latest && viewer.latest.seq > viewer.servedSeq) viewer.dropped++;
      viewer.latest = {
        seq: ++viewer.seq,
        tab: frame.tab,
        width: Math.max(1, Math.min(8192, Math.round(frame.width))),
        height: Math.max(1, Math.min(8192, Math.round(frame.height))),
        data: frame.data.toString("base64"),
      };
      for (const wake of [...viewer.waiters]) wake();
    });
    options.logger.info(`browser.remote.start scope=${scopeLabel(key)}`);
    return viewer;
  };
  /** Resolves after `ms`, or earlier when the viewer gets a frame or ends. */
  const nextFrame = (viewer: RemoteViewer, ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0) return resolve();
      const done = () => {
        clearTimeout(timer);
        viewer.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      viewer.waiters.add(done);
    });
  return {
    /**
     * The phone's next frame (see host.browser.view.remoteFrame). Shares the overlay's
     * screencast, keeps only the newest frame, serves at most one per
     * BROWSER_REMOTE_FRAME_INTERVAL_MS and none older than `after`. Never opens a session.
     */
    async remoteFrame(
      botId: string,
      after: number,
      waitMs: number,
      groupId?: string,
    ): Promise<HostBrowserRemoteFrame | null> {
      const key = browserProfileKey(botId, groupId);
      const browser = options.browsers.find(botId, groupId);
      let viewer = remotes.get(key);
      if (!browser?.open) {
        endRemote(key);
        return null;
      }
      if (viewer && viewer.browser !== browser) {
        endRemote(key);
        viewer = undefined;
      }
      const current = viewer ?? startRemote(key, browser);
      renew(key, current);
      const deadline = performance.now() + waitMs;
      // Pacing first: a phone that asks again at once still gets at most 2 frames per second.
      // Frames arriving meanwhile replace `latest`, so the wait never serves a stale one.
      const pace = Math.min(
        waitMs,
        current.servedAt + BROWSER_REMOTE_FRAME_INTERVAL_MS - performance.now(),
      );
      if (pace > 0) await new Promise((resolve) => setTimeout(resolve, pace));
      const fresh = () =>
        current.latest && current.latest.seq > after ? current.latest : undefined;
      if (!fresh() && remotes.get(key) === current)
        await nextFrame(current, deadline - performance.now());
      if (remotes.get(key) !== current) return null;
      renew(key, current);
      const frame = fresh();
      if (!frame) return null;
      current.servedAt = performance.now();
      current.servedSeq = frame.seq;
      return frame;
    },
    /** The phone left the view: its share of the screencast stops now. */
    remoteStop(botId: string, groupId?: string) {
      endRemote(browserProfileKey(botId, groupId));
    },
    /**
     * Starts or stops the stream. Never creates a browser session: a Bot whose browser is not
     * open has nothing to show, and the overlay asks again once `browser.state` says it is open.
     */
    visible(botId: string, visible: boolean, display?: BrowserViewDisplay, groupId?: string) {
      const key = browserProfileKey(botId, groupId);
      const current = streams.get(key);
      if (!visible) {
        end(key, "hidden");
        return;
      }
      const browser = options.browsers.find(botId, groupId);
      if (!browser?.open) {
        if (current) end(key, "closed");
        // Otherwise no trace at all: a view asking for a Bot without pages would look like
        // a renderer that never asked.
        else options.logger.info(`browser.view.skip botId=${key} reason=not_open`);
        return;
      }
      browser.setDisplay(display);
      if (current?.browser === browser) {
        // A reopened overlay has a fresh port: resend tabs and forget acks the old one owed.
        current.inFlight.clear();
        current.tabsKey = "";
        sendTabs(key, current);
        return;
      }
      if (current) end(key, "closed");
      start(key, browser);
    },
    /** Pushes tab/takeover changes now instead of at the next poll. */
    changed(botId: string, groupId?: string) {
      const key = browserProfileKey(botId, groupId);
      const stream = streams.get(key);
      if (stream) sendTabs(key, stream);
    },
    /** The brain child went away and its pages with it (brain-host `closeAll`). */
    closeAll() {
      for (const botId of [...streams.keys()]) end(botId, "closed");
      for (const key of [...remotes.keys()]) endRemote(key);
    },
    dispose() {
      offAck?.();
      for (const botId of [...streams.keys()]) end(botId, "closed");
      for (const key of [...remotes.keys()]) endRemote(key);
    },
  };
}
export type BrowserFrames = ReturnType<typeof createBrowserFrames>;
