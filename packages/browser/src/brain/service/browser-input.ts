import type { BrowserInputEvent, HostBrowserInputEvent } from "@pibot/browser-contract/full";

// Windows virtual key codes CDP needs for keys that do something without producing text.
const KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};
const CTRL = 2;
const META = 4;

function keyCode(key: string): number | undefined {
  const known = KEY_CODES[key];
  if (known !== undefined) return known;
  // Letters and digits map to their upper-case ASCII code (Ctrl+A, Ctrl+1 …).
  return /^[A-Za-z0-9]$/.test(key) ? key.toUpperCase().charCodeAt(0) : undefined;
}

/**
 * Overlay input (界面层 `browser.input`) → host input (`HostBrowserInputEvent`). Kept as the one
 * conversion point so the renderer stays a plain DOM event mapper and the host only dispatches:
 * the host format adds `keyCode` and key `text` that CDP needs, and drops wheel modifiers.
 * Typed text and IME output arrive as `text` events and are never logged here.
 */
export function toHostInput(event: BrowserInputEvent): HostBrowserInputEvent {
  switch (event.type) {
    case "mouse":
      return {
        type: "mouse",
        action: event.action,
        x: event.x,
        y: event.y,
        button: event.button,
        clickCount: event.clickCount,
        modifiers: event.modifiers,
      };
    case "wheel":
      return {
        type: "wheel",
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      };
    case "text":
      return { type: "text", text: event.text };
    case "key": {
      const code = keyCode(event.key);
      const shortcut = (event.modifiers & (CTRL | META)) !== 0;
      // Enter needs "\r" to submit forms and break lines, Space " " to press buttons and scroll;
      // other printable keys only come through here with Ctrl/Meta (plain typing is sent as
      // text), where they must not insert characters.
      const text =
        event.action !== "down" || shortcut
          ? undefined
          : event.key === "Enter"
            ? "\r"
            : event.key === " "
              ? " "
              : undefined;
      return {
        type: "key",
        action: event.action,
        key: event.key,
        code: event.code,
        modifiers: event.modifiers,
        ...(code !== undefined ? { keyCode: code } : {}),
        ...(text ? { text } : {}),
      };
    }
  }
}
