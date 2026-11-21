import type { Platform } from "../core/types.ts";

const posixOutputs = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd/1", "/dev/fd/2"]);

// Match literal output endpoints, not aliases resolved through arbitrary symbolic links.
export function isOutputTarget(path: string, platform: Platform): boolean {
  return platform === "win32" ? /^nul$/i.test(path) : posixOutputs.has(path);
}
