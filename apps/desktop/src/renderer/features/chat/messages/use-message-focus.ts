import type { Message } from "@pibot/protocol";
import type { MessageFocus } from "@pibot/renderer-kit";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Both DM and group viewports provide this small history port; routing remains with each controller.
export interface MessageFocusController {
  start(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    messages: Message[];
    loading: boolean;
    loadingMore: boolean;
    historyError: boolean;
    metadataError: boolean;
    hasMore: boolean;
  };
  loadMore(signal?: AbortSignal): Promise<void>;
}

// The history RPC has no remote cancel; consume its eventual result without continuing this lookup.
async function waitLocally<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function waitForHistory(controller: MessageFocusController, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let off = () => {};
    const finish = () => {
      off();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    const check = () => {
      const snapshot = controller.getSnapshot();
      if (!snapshot.loading && !snapshot.loadingMore) {
        finish();
        resolve();
      }
    };
    off = controller.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

type Notice = "missing" | "failed" | "stepMissing";
interface Lookup {
  focus: MessageFocus;
  read: AbortController;
  cancelled: boolean;
}
interface Result {
  controller: MessageFocusController;
  lookup: Lookup;
  outcome: "found" | "missing" | "failed";
}

export function useMessageFocus({
  controller,
  focus,
  consume,
  scroll,
  atBottom,
  anchor,
}: {
  controller: MessageFocusController;
  focus?: MessageFocus;
  consume(focus: MessageFocus): void;
  scroll: RefObject<HTMLDivElement | null>;
  atBottom: RefObject<boolean>;
  anchor: RefObject<{ height: number; top: number } | undefined>;
}) {
  const initialization = useRef<Promise<void>>(Promise.resolve());
  const lookup = useRef<Lookup | undefined>(undefined);
  const holdPosition = useRef(false);
  const [result, setResult] = useState<Result>();
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => {
    let active = true;
    holdPosition.current = false;
    setResult(undefined);
    setNotice(undefined);
    initialization.current = controller.start();
    void initialization.current.catch(() => {
      if (active) setNotice("failed");
    });
    // The viewport or shared cache owns disposal; locating history must not cancel live runs.
    return () => {
      active = false;
    };
  }, [controller]);
  useEffect(() => {
    if (!focus) return;
    const current: Lookup = { focus, read: new AbortController(), cancelled: false };
    lookup.current = current;
    holdPosition.current = false;
    anchor.current = undefined;
    atBottom.current = false;
    setResult(undefined);
    setNotice(undefined);
    const timer = setTimeout(() => current.read.abort("deadline"), 30_000);
    void (async () => {
      let outcome: Result["outcome"] = "missing";
      try {
        await waitLocally(initialization.current, current.read.signal);
        const seen = new Set<string>();
        for (let page = 0; page <= 25; page++) {
          await waitForHistory(controller, current.read.signal);
          const snapshot = controller.getSnapshot();
          if (snapshot.messages.some((message) => message.id === focus.messageId)) {
            outcome = "found";
            break;
          }
          if (snapshot.historyError || snapshot.metadataError) {
            outcome = "failed";
            break;
          }
          const before = snapshot.messages[0]?.id;
          if (!snapshot.hasMore || page === 25 || !before || seen.has(before)) break;
          seen.add(before);
          current.read.signal.throwIfAborted();
          await waitLocally(controller.loadMore(current.read.signal), current.read.signal);
        }
      } catch {
        // Cancellation is not a missing-message result. Read failures/deadlines have a separate hint.
        outcome = "failed";
      } finally {
        clearTimeout(timer);
      }
      if (!current.cancelled && lookup.current === current)
        setResult({ controller, lookup: current, outcome });
    })();
    return () => {
      current.cancelled = true;
      current.read.abort();
      clearTimeout(timer);
      if (lookup.current === current) lookup.current = undefined;
    };
  }, [controller, focus, atBottom, anchor]);
  useLayoutEffect(() => {
    if (!result || result.controller !== controller || result.lookup.cancelled) return;
    const container = scroll.current;
    if (!container) return;
    const target = result.lookup.focus;
    const message = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (element) => element.dataset.messageId === target.messageId,
    );
    const step =
      target.toolCallId && message
        ? Array.from(message.querySelectorAll<HTMLElement>("[data-tool-call-id]")).find(
            (element) => element.dataset.toolCallId === target.toolCallId,
          )
        : undefined;
    anchor.current = undefined;
    if (result.outcome === "found" && message) {
      const element = step || message;
      const bounds = element.getBoundingClientRect();
      container.scrollTop =
        container.scrollTop +
        bounds.top -
        container.getBoundingClientRect().top -
        (container.clientHeight - bounds.height) / 2;
      holdPosition.current = true;
      atBottom.current = false;
      if (target.toolCallId && !step) setNotice("stepMissing");
    } else {
      container.scrollTop = container.scrollHeight;
      holdPosition.current = false;
      atBottom.current = true;
      setNotice(result.outcome === "failed" ? "failed" : "missing");
    }
    consume(target);
    const timer = setTimeout(
      () => setResult((value) => (value === result ? undefined : value)),
      2_000,
    );
    return () => clearTimeout(timer);
  }, [result, controller, scroll, atBottom, anchor, consume]);
  const cancel = useCallback(() => {
    holdPosition.current = false;
    const current = lookup.current;
    if (current) {
      current.cancelled = true;
      current.read.abort();
      consume(current.focus);
      lookup.current = undefined;
    }
    setResult(undefined);
  }, [consume]);
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const interact = () => cancelRef.current();
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true]")
      )
        return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        interact();
    };
    container.addEventListener("wheel", interact, { passive: true });
    container.addEventListener("touchstart", interact, { passive: true });
    container.addEventListener("pointerdown", interact);
    container.addEventListener("keydown", key);
    return () => {
      container.removeEventListener("wheel", interact);
      container.removeEventListener("touchstart", interact);
      container.removeEventListener("pointerdown", interact);
      container.removeEventListener("keydown", key);
    };
  }, [scroll]);
  return {
    highlighted:
      result?.controller === controller && result.outcome === "found"
        ? result.lookup.focus
        : undefined,
    pending: !!focus,
    notice,
    holdPosition,
    cancel,
  };
}
