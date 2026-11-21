import type { BrowserInputEvent } from "@pibot/browser-contract/full";
import { type RefObject, useEffect } from "react";
import { frameRect } from "../pane/frame-fit.ts";
import type { FrameMeta } from "../pane/use-browser-frames.ts";

const IGNORED_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Dead",
  "Process",
  "Unidentified",
]);
const BUTTONS = ["left", "middle", "right"] as const;
const TEXT_CHUNK = 1000;

const modifiers = (event: MouseEvent | KeyboardEvent | WheelEvent) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

/** Maps a client point onto the frame (CSS pixels of the page) through where it is drawn. */
export function framePoint(
  canvas: HTMLCanvasElement,
  meta: FrameMeta,
  clientX: number,
  clientY: number,
) {
  const rect = canvas.getBoundingClientRect();
  const fit = frameRect(rect, { width: meta.imageWidth, height: meta.imageHeight });
  if (!fit) return null;
  const drawnWidth = fit.width;
  const drawnHeight = fit.height;
  const left = rect.left + fit.left;
  const top = rect.top + fit.top;
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
  return {
    x: clamp(((clientX - left) / drawnWidth) * meta.width, meta.width),
    y: clamp(((clientY - top) / drawnHeight) * meta.height, meta.height),
    inside:
      clientX >= left &&
      clientX <= left + drawnWidth &&
      clientY >= top &&
      clientY <= top + drawnHeight,
  };
}

/**
 * Takeover capture: mouse and wheel on the frame, keys and committed text (including IME and
 * paste) through a hidden textarea that keeps focus. Nothing is captured unless `enabled`.
 */
export function useTakeoverInput(options: {
  enabled: boolean;
  canvas: RefObject<HTMLCanvasElement | null>;
  sink: RefObject<HTMLTextAreaElement | null>;
  meta: FrameMeta | null;
  push(event: BrowserInputEvent): void;
}) {
  const { enabled, canvas, sink, meta, push } = options;
  useEffect(() => {
    const target = canvas.current;
    const text = sink.current;
    if (!enabled || !target || !text || !meta) return;
    const point = (event: MouseEvent) => framePoint(target, meta, event.clientX, event.clientY);
    const sendText = (value: string) => {
      for (let start = 0; start < value.length; start += TEXT_CHUNK)
        push({ type: "text", text: value.slice(start, start + TEXT_CHUNK) });
    };
    const mouse = (event: MouseEvent, action: "down" | "up" | "move") => {
      const at = point(event);
      if (!at || (action !== "up" && !at.inside && event.buttons === 0)) return;
      // A move during a drag carries the held button so selections and drags work.
      const button =
        action !== "move"
          ? (BUTTONS[event.button] ?? "left")
          : event.buttons & 1
            ? "left"
            : event.buttons & 4
              ? "middle"
              : event.buttons & 2
                ? "right"
                : "none";
      push({
        type: "mouse",
        action,
        x: at.x,
        y: at.y,
        button,
        clickCount: action === "move" ? 0 : Math.max(1, Math.min(3, event.detail || 1)),
        modifiers: modifiers(event),
      });
    };
    const move = (event: MouseEvent) => mouse(event, "move");
    const up = (event: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      target.addEventListener("mousemove", move);
      mouse(event, "up");
    };
    const down = (event: MouseEvent) => {
      event.preventDefault();
      text.focus({ preventScroll: true });
      mouse(event, "down");
      // Follow the drag outside the frame until release, like a real page would.
      target.removeEventListener("mousemove", move);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = point(event);
      if (!at?.inside) return;
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      push({
        type: "wheel",
        x: at.x,
        y: at.y,
        deltaX: Math.max(-10000, Math.min(10000, event.deltaX * unit)),
        deltaY: Math.max(-10000, Math.min(10000, event.deltaY * unit)),
        modifiers: modifiers(event),
      });
    };
    const menu = (event: MouseEvent) => event.preventDefault();
    const pressed = new Set<string>();
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || IGNORED_KEYS.has(event.key)) return;
      const shortcut = event.ctrlKey || event.metaKey;
      // Plain typing arrives as text (input / composition); paste arrives as a paste event.
      if (event.key.length === 1 && event.key !== " " && !shortcut) return;
      if (shortcut && event.key.toLowerCase() === "v") return;
      event.preventDefault();
      pressed.add(event.code);
      push({
        type: "key",
        action: "down",
        key: event.key.slice(0, 32),
        code: event.code.slice(0, 32),
        modifiers: modifiers(event),
      });
    };
    const keyup = (event: KeyboardEvent) => {
      if (!pressed.delete(event.code)) return;
      event.preventDefault();
      push({
        type: "key",
        action: "up",
        key: event.key.slice(0, 32),
        code: event.code.slice(0, 32),
        modifiers: modifiers(event),
      });
    };
    const input = (event: Event) => {
      const data = event instanceof InputEvent ? event : undefined;
      if (!data || data.isComposing) return;
      if (data.inputType === "insertText" && data.data) sendText(data.data);
      if (!data.inputType.startsWith("insertComposition")) text.value = "";
    };
    const composed = (event: CompositionEvent) => {
      if (event.data) sendText(event.data);
      text.value = "";
    };
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      const value = event.clipboardData?.getData("text/plain") ?? "";
      if (value) sendText(value);
    };
    target.addEventListener("mousedown", down);
    target.addEventListener("mousemove", move);
    target.addEventListener("wheel", wheel, { passive: false });
    target.addEventListener("contextmenu", menu);
    text.addEventListener("keydown", keydown);
    text.addEventListener("keyup", keyup);
    text.addEventListener("input", input);
    text.addEventListener("compositionend", composed);
    text.addEventListener("paste", paste);
    text.focus({ preventScroll: true });
    return () => {
      target.removeEventListener("mousedown", down);
      target.removeEventListener("mousemove", move);
      target.removeEventListener("wheel", wheel);
      target.removeEventListener("contextmenu", menu);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      text.removeEventListener("keydown", keydown);
      text.removeEventListener("keyup", keyup);
      text.removeEventListener("input", input);
      text.removeEventListener("compositionend", composed);
      text.removeEventListener("paste", paste);
    };
  }, [enabled, canvas, sink, meta, push]);
}
