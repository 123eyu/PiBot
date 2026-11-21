import type { BrowserInputEvent } from "@pibot/browser-contract/full";

const MAX_PENDING = 64;

/**
 * Takeover input goes out one request at a time, in order. Pointer moves and wheel deltas are
 * coalesced while a request is in flight, so dragging or scrolling costs about one business
 * request per round trip instead of one per DOM event (spec acceptance 12: chat stays smooth).
 */
export function createInputQueue(
  send: (event: BrowserInputEvent) => Promise<void>,
  failed: (error: unknown) => void,
) {
  const pending: BrowserInputEvent[] = [];
  let running = false;
  let closed = false;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      for (let next = pending.shift(); next && !closed; next = pending.shift()) {
        try {
          await send(next);
        } catch (error) {
          // The rest was aimed at a page state that no longer holds (hand-back, closed tab).
          pending.length = 0;
          failed(error);
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    push(event: BrowserInputEvent) {
      if (closed) return;
      const last = pending.at(-1);
      if (event.type === "mouse" && event.action === "move" && last?.type === "mouse") {
        if (last.action === "move") pending[pending.length - 1] = event;
        else pending.push(event);
      } else if (event.type === "wheel" && last?.type === "wheel") {
        pending[pending.length - 1] = {
          ...event,
          deltaX: Math.max(-10000, Math.min(10000, last.deltaX + event.deltaX)),
          deltaY: Math.max(-10000, Math.min(10000, last.deltaY + event.deltaY)),
        };
      } else pending.push(event);
      // Overflow only drops moves; presses, keys and text keep their order.
      while (pending.length > MAX_PENDING) {
        const index = pending.findIndex((item) => item.type === "mouse" && item.action === "move");
        if (index < 0) break;
        pending.splice(index, 1);
      }
      void pump();
    },
    close() {
      closed = true;
      pending.length = 0;
    },
  };
}
