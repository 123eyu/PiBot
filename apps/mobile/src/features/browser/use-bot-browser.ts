import type { BrowserState, RemoteBrowserInput } from "@pibot/protocol";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useEffect, useRef, useState } from "react";
import { useLinkState, useRuntime, useText } from "../../runtime/context.tsx";
import { confirmLocally } from "../../runtime/local-auth.ts";
import { useAction } from "../../runtime/use-action.ts";
import {
  type BrowserTarget,
  navigate,
  nextFrame,
  sendInput,
  setTakeover,
  stopWatching,
} from "./calls.ts";

export interface ShownFrame {
  seq: number;
  tabId: string;
  /** Page CSS pixels the frame covers; also its aspect ratio. */
  width: number;
  height: number;
  uri: string;
}
/** A closed browser answers at once; asking again right away would only spin. */
const CLOSED_RETRY_MS = 2000;
const ERROR_RETRY_MS = 2000;

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The phone's live view of the computer's Bot browser. Frames are pulled one at a
 * time while the view is open and the computer online; leaving the view (or the connection
 * going away) stops the stream, and the computer hands a takeover back on its own then.
 * Nothing shown here is stored: frames and typed text live only in this screen's state.
 */
export function useBotBrowser(target: BrowserTarget, conversationId: string | undefined) {
  const runtime = useRuntime(),
    mobile = useLinkState(),
    t = useText();
  const [state, setState] = useState<BrowserState>();
  const [frame, setFrame] = useState<ShownFrame>();
  const [streamError, setStreamError] = useState(false);
  /** This phone holds the takeover the computer reports (not the desktop or another phone). */
  const [mine, setMine] = useState(false);
  const action = useAction(`${mobile.selectedId}:browser:${target.botId}`, mobile.peer);
  const input = useAction(`${mobile.selectedId}:browser-input:${target.botId}`, mobile.peer);
  const frameRef = useRef<ShownFrame | undefined>(undefined);
  const online = mobile.status === "online";
  const { botId, groupId } = target;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the Bot and the connection own the stream; runtime is stable.
  useEffect(() => {
    setFrame(undefined);
    frameRef.current = undefined;
    setMine(false);
    if (!online || !mobile.peer) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const scope = { botId, ...(groupId ? { groupId } : {}) };
    void (async () => {
      let after = 0;
      while (!signal.aborted) {
        try {
          const result = await nextFrame(runtime, scope, after, signal);
          if (signal.aborted) return;
          setStreamError(false);
          setState(result.state);
          setMine(result.mine);
          if (result.frame) {
            after = result.frame.seq;
            const shown = {
              seq: result.frame.seq,
              tabId: result.frame.tabId,
              width: result.frame.width,
              height: result.frame.height,
              uri: `data:image/jpeg;base64,${result.frame.data}`,
            };
            frameRef.current = shown;
            setFrame(shown);
          } else if (!result.state.open) {
            frameRef.current = undefined;
            setFrame(undefined);
            await pause(CLOSED_RETRY_MS, signal);
          }
        } catch {
          if (signal.aborted) return;
          setStreamError(true);
          await pause(ERROR_RETRY_MS, signal);
        }
      }
    })();
    return () => {
      controller.abort();
      // Best effort: the computer also stops on its own when no request comes for a while.
      void stopWatching(runtime, scope).catch(() => undefined);
    };
  }, [botId, groupId, online, mobile.peer]);

  const scope = { botId, ...(groupId ? { groupId } : {}) };
  const takeOver = () =>
    action.run(async (signal) => {
      await confirmLocally(t("unlockTakeover"), t("cancel"), signal);
      const next = await setTakeover(runtime, scope, true, conversationId, signal);
      signal.throwIfAborted();
      setState(next);
      setMine(next.takeover);
      return next.takeover;
    });
  const handBack = () =>
    action.run(async (signal) => {
      const next = await setTakeover(runtime, scope, false, undefined, signal);
      signal.throwIfAborted();
      setState(next);
      setMine(false);
      return true;
    });
  const send = (event: RemoteBrowserInput) =>
    input.run(async (signal) => {
      const shown = frameRef.current;
      if (!shown) return;
      try {
        await sendInput(runtime, scope, shown, event, signal);
      } catch (error) {
        // The page moved on between the frame and the tap; the next frame is on its way.
        if (error instanceof RpcError && error.code === RpcErrorCodes.invalidParams)
          input.setError("browserStale");
        else throw error;
      }
      return true;
    });
  const go = (kind: "url" | "back" | "forward" | "reload", url?: string) =>
    action.run(async (signal) => {
      const tabId = frameRef.current?.tabId ?? state?.tabs.find((tab) => tab.active)?.id;
      if (!tabId) return;
      const next = await navigate(runtime, scope, tabId, kind, url, signal);
      signal.throwIfAborted();
      setState(next);
      return true;
    });
  const active = state?.tabs.find((tab) => tab.active);
  return {
    online,
    state,
    frame,
    address: active?.url ?? "",
    loading: !!active?.loading,
    takenOver: !!state?.takeover && mine,
    elsewhere: !!state?.takeover && !mine,
    streamError,
    action,
    input,
    takeOver,
    handBack,
    tap: (x: number, y: number) => send({ type: "tap", x, y }),
    scroll: (x: number, y: number, deltaX: number, deltaY: number) =>
      send({ type: "scroll", x, y, deltaX, deltaY }),
    type: (text: string) => send({ type: "text", text }),
    key: (key: Extract<RemoteBrowserInput, { type: "key" }>["key"]) => send({ type: "key", key }),
    go,
  };
}
export type BotBrowserView = ReturnType<typeof useBotBrowser>;
