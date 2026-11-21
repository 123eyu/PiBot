import type { BrowserExtensionPlatform } from "./types.ts";
import { unixBrowserExtensionPlatform } from "./unix.ts";
import { windowsBrowserExtensionPlatform } from "./win.ts";

export type { BrowserExtensionPlatform } from "./types.ts";

export function browserExtensionPlatform(platform = process.platform): BrowserExtensionPlatform {
  return platform === "win32" ? windowsBrowserExtensionPlatform() : unixBrowserExtensionPlatform();
}
