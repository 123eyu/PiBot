import { isIP } from "node:net";
import { ExecError } from "../core/types.ts";
import { darwinListeners } from "./darwin.ts";
import { linuxListeners } from "./linux.ts";
import type { ListenerScan } from "./types.ts";
import { win32Listeners } from "./win32.ts";

export type { ListenerScan, ListeningSocket } from "./types.ts";

/** Only these local addresses count as "this machine only". */
export function isLoopbackAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::1") return true;
  const v4 = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

/** TCP ports the given processes listen on, by one read-only per-platform method. */
export async function listeningSockets(
  pids: readonly number[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ListenerScan> {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux")
    return { supported: false, reason: "platform_unsupported" };
  // A tree this large is not a dev server; bound the argv and the scan.
  const list = [...new Set(pids)];
  if (list.length > 256) throw new ExecError("command_failed", "listener_check_failed");
  if (!list.length) return { supported: true, sockets: [] };
  if (platform === "linux") return { supported: true, ...(await linuxListeners(list, signal)) };
  const sockets =
    platform === "darwin"
      ? await darwinListeners(list, env, signal)
      : await win32Listeners(list, env, signal);
  return { supported: true, sockets };
}
