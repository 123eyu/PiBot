import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopbackAddress } from "./index.ts";
import type { ListeningSocket } from "./types.ts";

/**
 * Linux (owner decision 2026-11-11, kali acceptance F-L1): bubblewrap gives each sandboxed command
 * its own network namespace, so a dev server the Bot starts is unreachable from this machine and
 * from the Bot browser. Network isolation stays; only loopback ports the command listens on are
 * forwarded: the same 127.0.0.1 port on the host relays to a private unix socket, served by a socat
 * that runs inside the command's network namespace (joined with nsenter as the namespace owner; no
 * privilege beyond what created the sandbox). Nothing is ever bound beyond 127.0.0.1.
 */

const NSENTER = ["/usr/bin/nsenter", "/bin/nsenter"];
const SOCAT = ["/usr/bin/socat", "/bin/socat"];
const MAX_PORTS = 16;

async function first(paths: readonly string[]) {
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

/**
 * Loopback LISTEN sockets of the network namespace the job's `pids` share, owned by one of those
 * processes. SRT's own in-sandbox proxy bridges (socat … UNIX-CONNECT:, ports 3128 / 1080) are not
 * services of the Bot and are left out (kali acceptance: they showed up as "open port" buttons).
 */
export async function namespacedListeners(
  pids: readonly number[],
  signal: AbortSignal,
  proc = "/proc",
): Promise<ListeningSocket[]> {
  const owners = new Map<string, number>();
  for (const pid of pids.slice(0, 256)) {
    signal.throwIfAborted();
    const argv = await readFile(`${proc}/${pid}/cmdline`, "utf8").catch(() => "");
    const parts = argv.split("\0");
    if (
      /(^|\/)socat$/.test(parts[0] ?? "") &&
      parts.some((part) => part.startsWith("UNIX-CONNECT:"))
    )
      continue;
    const fds = await readdir(`${proc}/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds.slice(0, 4096)) {
      const target = await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode) owners.set(inode, pid);
    }
  }
  const at = pids[0];
  if (at === undefined || !owners.size) return [];
  const sockets: ListeningSocket[] = [];
  for (const [file, v6] of [
    ["tcp", false],
    ["tcp6", true],
  ] as const) {
    const table = await readFile(`${proc}/${at}/net/${file}`, { encoding: "utf8", signal }).catch(
      () => "",
    );
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== "0A") continue;
      const pid = owners.get(fields[9] as string);
      if (pid === undefined) continue;
      const [hex, portHex] = (fields[1] as string).split(":");
      if (!hex || !portHex) continue;
      const any = /^0+$/.test(hex);
      // Inside the sandbox "every interface" is the sandbox's own loopback only.
      const loopback = v6
        ? any || hex === "00000000000000000000000001000000"
        : any || hex.endsWith("7F");
      if (!loopback) continue;
      sockets.push({ pid, address: v6 ? "::1" : "127.0.0.1", port: Number.parseInt(portHex, 16) });
    }
  }
  return sockets;
}

interface Forward {
  port: number;
  server: Server;
  relay: ChildProcess;
}

/** One per isolated background job; `dispose` when the job ends. */
export function createNamespaceForwarder() {
  const forwards = new Map<number, Forward>();
  const refused = new Set<number>();
  let dir: string | undefined;
  let tools: Promise<{ nsenter?: string; socat?: string }> | undefined;
  let disposed = false;

  async function open(pid: number, port: number, v6: boolean): Promise<Forward | undefined> {
    tools ??= Promise.all([first(NSENTER), first(SOCAT)]).then(([nsenter, socat]) => ({
      nsenter,
      socat,
    }));
    const { nsenter, socat } = await tools;
    if (!nsenter || !socat) return undefined;
    dir ??= await mkdtemp(join(tmpdir(), "pibot-forward-"));
    const socket = join(dir, `${port}.sock`);
    const relay = spawn(
      nsenter,
      [
        "--preserve-credentials",
        "-U",
        "-n",
        "-t",
        String(pid),
        socat,
        `UNIX-LISTEN:${socket},fork,mode=600`,
        v6 ? `TCP6:[::1]:${port}` : `TCP4:127.0.0.1:${port}`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    relay.on("error", () => {
      // Reported as "no forward" by the caller's next sync.
    });
    // The first browser request must not race socat's bind of the private socket.
    for (let waited = 0; waited < 2000; waited += 50) {
      if (relay.exitCode !== null) break;
      if (
        await access(socket).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (relay.exitCode !== null) return undefined;
    const server = createServer((client) => {
      const upstream = connect(socket);
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
    });
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      // The host side only ever binds loopback.
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
    });
    if (!listening) {
      relay.kill();
      server.close();
      return undefined;
    }
    server.unref();
    relay.unref();
    return { port, server, relay };
  }

  function close(forward: Forward) {
    forward.server.close();
    forward.relay.kill();
    forwards.delete(forward.port);
  }

  return {
    /** Forwards the namespace's loopback listeners; returns the ports reachable on this host. */
    async sync(pid: number, sockets: readonly ListeningSocket[]): Promise<number[]> {
      if (disposed) return [];
      const wanted = new Map<number, boolean>();
      for (const socket of sockets)
        if (isLoopbackAddress(socket.address) && wanted.size < MAX_PORTS)
          wanted.set(socket.port, wanted.get(socket.port) ?? socket.address === "::1");
      for (const forward of [...forwards.values()])
        if (!wanted.has(forward.port) || forward.relay.exitCode !== null) close(forward);
      for (const port of refused) if (!wanted.has(port)) refused.delete(port);
      for (const [port, v6] of wanted) {
        if (forwards.has(port) || refused.has(port)) continue;
        const forward = await open(pid, port, v6);
        // A host port already in use (or missing tools) is not retried every tick.
        if (forward && !disposed) forwards.set(port, forward);
        else {
          if (forward) close(forward);
          refused.add(port);
        }
      }
      return [...forwards.keys()];
    },
    async dispose() {
      disposed = true;
      for (const forward of [...forwards.values()]) close(forward);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
export type NamespaceForwarder = ReturnType<typeof createNamespaceForwarder>;
