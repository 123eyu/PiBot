import { readdir, readFile, readlink } from "node:fs/promises";
import { ExecError } from "../core/types.ts";
import type { ListeningSocket } from "./types.ts";

const gone = (error: unknown) =>
  error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code));

/**
 * Linux: procfs only, no external tool. A command isolated by bubblewrap runs in its own network
 * namespace; its ports are unreachable from this machine and are not reported (the pid lands in
 * `namespaced`). A command the user allowed to run without isolation shares our namespace, so
 * its listeners are real host ports and must be seen, both for "open in browser" and for the
 * stop-on-non-loopback rule.
 */
export async function linuxListeners(
  pids: readonly number[],
  signal: AbortSignal,
  proc = "/proc",
): Promise<{ sockets: ListeningSocket[]; namespaced: number[] }> {
  const own = await readlink(`${proc}/self/ns/net`);
  const inodes = new Map<string, number>();
  const namespaced: number[] = [];
  for (const pid of pids) {
    signal.throwIfAborted();
    let ns: string;
    try {
      ns = await readlink(`${proc}/${pid}/ns/net`);
    } catch (error) {
      if (!gone(error)) throw new ExecError("command_failed", "listener_check_failed");
      // Exited between ps and now; unreadable live processes are inspection failures.
      continue;
    }
    if (ns !== own) {
      namespaced.push(pid);
      continue;
    }
    let fds: string[];
    try {
      fds = await readdir(`${proc}/${pid}/fd`);
    } catch (error) {
      if (!gone(error)) throw new ExecError("command_failed", "listener_check_failed");
      continue;
    }
    // A dev server holds a handful of descriptors; bound the walk like the macOS argv bound.
    if (fds.length > 4096) throw new ExecError("command_failed", "listener_check_failed");
    for (const fd of fds) {
      signal.throwIfAborted();
      const target = await readlink(`${proc}/${pid}/fd/${fd}`).catch((error: unknown) => {
        if (!gone(error)) throw new ExecError("command_failed", "listener_check_failed");
        return "";
      });
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode) inodes.set(inode, pid);
    }
  }
  if (!inodes.size) return { sockets: [], namespaced };
  const sockets: ListeningSocket[] = [];
  for (const [file, v6] of [
    ["tcp", false],
    ["tcp6", true],
  ] as const) {
    // Our own view of the table is the host namespace the unisolated commands share.
    const table = await readFile(`${proc}/self/net/${file}`, { encoding: "utf8", signal }).catch(
      (error: unknown) => {
        signal.throwIfAborted();
        if (!gone(error)) throw new ExecError("command_failed", "listener_check_failed");
        return "";
      },
    );
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // sl local rem st tx:rx tr:when retrnsmt uid timeout inode; st 0A is LISTEN.
      if (fields.length < 10 || fields[3] !== "0A") continue;
      const pid = inodes.get(fields[9] as string);
      if (pid === undefined) continue;
      const [hex, portHex] = (fields[1] as string).split(":");
      if (!hex || !portHex) continue;
      sockets.push({
        pid,
        address: v6 ? ipv6(hex) : ipv4(hex),
        port: Number.parseInt(portHex, 16),
      });
    }
  }
  return { sockets, namespaced };
}

/** procfs prints each 32-bit word in host byte order (little-endian on x64 / arm64). */
function words(hex: string) {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    const word = hex.slice(i, i + 8);
    for (let b = 6; b >= 0; b -= 2) out.push(Number.parseInt(word.slice(b, b + 2), 16));
  }
  return out;
}

function ipv4(hex: string) {
  return words(hex).join(".");
}

function ipv6(hex: string) {
  const bytes = words(hex);
  // IPv4-mapped (::ffff:a.b.c.d) is how a dual-stack loopback bind shows up.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255)
    return `::ffff:${bytes.slice(12).join(".")}`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push((((bytes[i] as number) << 8) | (bytes[i + 1] as number)).toString(16));
  const full = groups.join(":");
  if (full === "0:0:0:0:0:0:0:0") return "::";
  if (full === "0:0:0:0:0:0:0:1") return "::1";
  return full;
}
