import {
  type BrowserFrameAck,
  BrowserFrameMessageSchema,
  type BrowserTab,
  type BrowserViewDisplay,
} from "@pibot/browser-contract/full";
import type { Peer } from "@pibot/renderer-kit";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useBrowserUiPorts } from "../../shell/ports.tsx";
import { paintFrame } from "./frame-fit.ts";

export interface FrameMeta {
  tabId: string;
  documentId?: string;
  seq: number;
  /** Page CSS pixels the frame covers; overlay input is mapped into this space. */
  width: number;
  height: number;
  /** Pixel size of the frame image, which is what gets fitted into the canvas. */
  imageWidth: number;
  imageHeight: number;
}

/** After the host ends a stream we still want (closed, stalled), ask again after a pause. */
const RETRY_MS = 1500;

function askView(
  peer: Peer,
  botId: string,
  groupId: string | undefined,
  box: BrowserViewDisplay | null,
  signal: AbortSignal,
) {
  void peer
    .call(
      "browser.view",
      { botId, ...(groupId ? { groupId } : {}), visible: true, ...(box ? { display: box } : {}) },
      { signal },
    )
    .catch(() => {
      // Unavailable or not open yet: `browser.state` / the retry counter asks again.
    });
}

/**
 * Receives one Bot's overlay frames on the dedicated port (never the business port), draws
 * each JPEG onto `canvas` off the main thread (createImageBitmap) and acknowledges it only after
 * drawing, so a busy renderer slows the stream instead of queueing frames. `want` starts and
 * stops the host stream through `browser.view`; it must already include visibility.
 */
export function useBrowserFrames(options: {
  botId: string;
  groupId?: string;
  peer: Peer | null;
  want: boolean;
  canvas: RefObject<HTMLCanvasElement | null>;
  /** Size of the frame box; the host fits the viewport and stream resolution to it. */
  display: BrowserViewDisplay | null;
}) {
  const { onBrowserFrames } = useBrowserUiPorts();
  const { botId, groupId, peer, want, canvas, display } = options;
  const displayRef = useRef(display);
  displayRef.current = display;
  const wantRef = useRef(want);
  wantRef.current = want;
  const [meta, setMeta] = useState<FrameMeta | null>(null);
  const [live, setLive] = useState<{ tabs: BrowserTab[]; takeover: boolean } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [retry, setRetry] = useState(0);
  const metaRef = useRef<FrameMeta | null>(null);
  // Kept to repaint at once when the canvas resizes, before the host sends a refitted frame.
  const shownRef = useRef<ImageBitmap | null>(null);

  useEffect(() => {
    setMeta(null);
    metaRef.current = null;
    setLive(null);
    setStreaming(false);
    let port: MessagePort | undefined;
    let drawing: Promise<void> = Promise.resolve();
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const off = onBrowserFrames((id, next, portGroupId) => {
      if (id !== botId || portGroupId !== groupId) return;
      port?.close();
      port = next;
      const current = next;
      next.onmessage = (event: MessageEvent) => {
        if (disposed || port !== current) return;
        const parsed = BrowserFrameMessageSchema.safeParse(event.data);
        if (!parsed.success || parsed.data.botId !== botId || parsed.data.groupId !== groupId)
          return;
        const message = parsed.data;
        if (message.type === "tabs") {
          setLive({ tabs: message.tabs, takeover: message.takeover });
          return;
        }
        if (message.type === "end") {
          setStreaming(false);
          current.close();
          if (port === current) port = undefined;
          // "hidden" answers a stop. One that lands while this view still wants frames is a stop
          // that overtook the latest start (another view of this Bot, a reconnect): ask again,
          // or the view stays on its last frame for good.
          if (message.reason !== "hidden" || wantRef.current)
            retryTimer = setTimeout(() => setRetry((value) => value + 1), RETRY_MS);
          return;
        }
        drawing = drawing
          .then(async () => {
            if (disposed || port !== current) return;
            const bitmap = await createImageBitmap(
              new Blob([message.data as Uint8Array<ArrayBuffer>], { type: message.mimeType }),
            );
            if (disposed || port !== current) {
              bitmap.close();
              return;
            }
            shownRef.current?.close();
            shownRef.current = bitmap;
            if (canvas.current) paintFrame(canvas.current, bitmap);
            const previous = metaRef.current;
            if (
              previous?.tabId !== message.tabId ||
              previous.seq !== message.seq ||
              previous.documentId !== message.documentId ||
              previous.width !== message.width ||
              previous.height !== message.height ||
              previous.imageWidth !== bitmap.width ||
              previous.imageHeight !== bitmap.height
            ) {
              metaRef.current = {
                tabId: message.tabId,
                seq: message.seq,
                documentId: message.documentId,
                width: message.width,
                height: message.height,
                imageWidth: bitmap.width,
                imageHeight: bitmap.height,
              };
              setMeta(metaRef.current);
            }
            setStreaming(true);
          })
          .catch(() => {
            // An undecodable frame is skipped; the next one replaces it and the ack below
            // keeps the stream flowing.
          })
          .finally(() => {
            if (disposed || port !== current) return;
            const ack: BrowserFrameAck = {
              type: "ack",
              seq: message.seq,
              ...(groupId ? { groupId } : {}),
            };
            current.postMessage(ack);
          });
      };
      next.start();
    });
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      off();
      port?.close();
      port = undefined;
      shownRef.current?.close();
      shownRef.current = null;
    };
  }, [botId, groupId, canvas, onBrowserFrames]);

  // The canvas backing store follows the element's size; without a repaint a resized canvas
  // would stretch the old picture until the next frame. `want` remounts the canvas with the pane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `want` re-reads canvas.current
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const observer = new ResizeObserver(() => {
      if (shownRef.current) paintFrame(target, shownRef.current);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canvas, want]);

  useEffect(() => {
    if (!peer || !want) {
      setStreaming(false);
      return;
    }
    const controller = new AbortController();
    askView(peer, botId, groupId, displayRef.current, controller.signal);
    return () => {
      controller.abort();
      void peer
        .call("browser.view", { botId, ...(groupId ? { groupId } : {}), visible: false })
        .catch(() => {
          // The host also stops streams nobody acknowledges, so a lost stop is bounded.
        });
    };
  }, [peer, botId, groupId, want]);

  // Restarting an ended stream only asks again: a stop first would end the stream it restarts
  // (and, after a "hidden" end, retry the same way forever).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the retry counter asks again
  useEffect(() => {
    if (!retry || !peer || !wantRef.current) return;
    const controller = new AbortController();
    askView(peer, botId, groupId, displayRef.current, controller.signal);
    return () => controller.abort();
  }, [retry]);

  // A resized box (wide, fullscreen, window) refits the running stream without restarting it.
  useEffect(() => {
    if (!peer || !want || !display) return;
    void peer
      .call("browser.view", { botId, ...(groupId ? { groupId } : {}), visible: true, display })
      .catch(() => {
        // The next resize or restart sends the size again.
      });
  }, [peer, botId, groupId, want, display]);

  return { meta, live, streaming };
}
