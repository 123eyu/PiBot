import { ComputerError, notDelivered } from "../core/errors.ts";
import type { AppInfo, Platform } from "../core/types.ts";

const ALIASES: Readonly<Record<string, string>> = {
  command: "cmd",
  meta: "super",
  win: "super",
  windows: "super",
  lwin: "super",
  rwin: "super",
  super_l: "super",
  super_r: "super",
  meta_l: "super",
  meta_r: "super",
  "⊞": "super",
  leftcommand: "cmd",
  rightcommand: "cmd",
  lcmd: "cmd",
  rcmd: "cmd",
  os: "super",
  control: "ctrl",
  option: "alt",
  escape: "esc",
  " ": "space",
  spacebar: "space",
  "⌘": "cmd",
  "⌃": "ctrl",
  "⌥": "alt",
  "⇧": "shift",
  delete: "del",
};
export const SYSTEM_SHORTCUTS: Record<Platform, readonly (readonly string[])[]> = {
  darwin: [
    ["cmd", "space"],
    ["cmd", "tab"],
    ["cmd", "alt", "esc"],
    ["ctrl", "cmd", "q"],
    ["cmd", "shift", "3"],
    ["cmd", "shift", "4"],
    ["cmd", "shift", "5"],
    ["ctrl", "up"],
    ["ctrl", "down"],
    ["ctrl", "left"],
    ["ctrl", "right"],
    ["ctrl", "f2"],
    ["ctrl", "f3"],
    ["ctrl", "power"],
    ["ctrl", "eject"],
    ["cmd", "alt", "power"],
    ["cmd", "alt", "eject"],
  ],
  win32: [
    ["alt", "tab"],
    ["alt", "esc"],
    ["ctrl", "alt", "del"],
    ["ctrl", "esc"],
    ["ctrl", "shift", "esc"],
  ],
  linux: [
    ["alt", "tab"],
    ["alt", "esc"],
    ["alt", "f2"],
    ["ctrl", "alt", "del"],
    ["ctrl", "alt", "backspace"],
  ],
};

export function normalizedKeys(combo: readonly string[]): string[] {
  return combo.map((key) => ALIASES[key.toLowerCase()] ?? key.toLowerCase());
}

// AppKit control-letter bindings can insert text (Ctrl+O inserts a newline). Only these
// exact, platform-specific commands may run without a confirmed text receiver.
const NON_TEXT_SHORTCUTS: Readonly<Record<Platform, readonly string[]>> = {
  darwin: ["cmd+n", "cmd+n+shift", "a+cmd", "c+cmd", "cmd+f", "cmd+w", "alt+left", "alt+right"],
  win32: [
    "ctrl+n",
    "ctrl+n+shift",
    "a+ctrl",
    "c+ctrl",
    "ctrl+f",
    "ctrl+w",
    "alt+left",
    "alt+right",
  ],
  linux: [
    "ctrl+n",
    "ctrl+n+shift",
    "a+ctrl",
    "c+ctrl",
    "ctrl+f",
    "ctrl+w",
    "alt+left",
    "alt+right",
  ],
};

/** Unknown combinations, extra modifiers, Option letters, AltGr and paste retain the guard. */
export function isNonTextShortcut(platform: Platform, combo: readonly string[] | undefined) {
  const keys = normalizedKeys(combo ?? []);
  return NON_TEXT_SHORTCUTS[platform].includes(keys.sort().join("+"));
}

/** Extra modifiers must not turn a system shortcut into an allowed one. */
export function assertAppShortcut(platform: Platform, combo: readonly string[] | undefined) {
  const keys = new Set(normalizedKeys(combo ?? []));
  if (
    keys.has("super") ||
    (platform !== "darwin" && keys.has("cmd")) ||
    keys.has("printscreen") ||
    keys.has("prtsc") ||
    (platform === "linux" &&
      keys.has("ctrl") &&
      keys.has("alt") &&
      [...keys].some((key) => /^f\d+$/.test(key))) ||
    SYSTEM_SHORTCUTS[platform].some((shortcut) => shortcut.every((key) => keys.has(key)))
  )
    throw new ComputerError("unsupported", "system_shortcut_not_allowed");
}

export function assertFrontmost(actual: AppInfo | null, target: Pick<AppInfo, "id" | "pid">) {
  if (!actual || actual.pid !== target.pid || actual.id.toLowerCase() !== target.id.toLowerCase())
    throw notDelivered("target_moved", "target_app_not_frontmost");
}
