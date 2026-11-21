import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { isLanAddress, LAN_SERVICE } from "@pibot/link/lan";
import multicastDns from "multicast-dns";
import { type WebSocket, WebSocketServer } from "ws";

export interface LanInterface {
  address: string;
  netmask: string;
}
export function lanInterfaces(): LanInterface[] {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((v) => !v.internal && v.family === "IPv4" && isLanAddress(v.address))
    .map(({ address, netmask }) => ({ address, netmask }))
    .sort((a, b) => a.address.localeCompare(b.address))
    .slice(0, 8);
}
export function sameLan(remote: string) {
  return isPrivateLanSource(remote);
}

/** LAN upgrade may cross VPN/private subnets; CGNAT is deliberately excluded. */
export function isPrivateLanSource(value: string) {
  const normalized = value.replace(/^::ffff:/i, "");
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized)) return isLanAddress(normalized);
  const lower = value.toLowerCase().split("%", 1)[0] ?? "";
  return (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

export interface LanAdvertisement {
  interface: LanInterface;
  instance: string;
  port: number;
}
export async function advertiseLan(value: LanAdvertisement, warn: () => void) {
  // Unix needs a group-bound receiver but cannot send with that socket's source address.
  // Keep a private-address sender and a group receiver, with membership limited to this NIC.
  const mdns = multicastDns({ interface: value.interface.address, bind: value.interface.address });
  const receiver =
    process.platform === "win32"
      ? mdns
      : multicastDns({ interface: value.interface.address, bind: "224.0.0.251" });
  const sockets = [...new Set([mdns, receiver])];
  const type = `_${LAN_SERVICE}._tcp.local`;
  const name = `${value.instance}.${type}`;
  const host = `${value.instance}.local`;
  const records = [
    { name: type, type: "PTR" as const, ttl: 120, data: name },
    {
      name,
      type: "SRV" as const,
      ttl: 120,
      data: { port: value.port, target: host, priority: 0, weight: 0 },
    },
    { name, type: "TXT" as const, ttl: 120, data: [Buffer.from("v=1")] },
    { name: host, type: "A" as const, ttl: 120, data: value.interface.address },
  ];
  let closed = false;
  const announce = () => {
    if (!closed)
      mdns.respond(records, (error) => {
        if (error) warn();
      });
  };
  for (const socket of sockets) {
    socket.on("error", warn);
    socket.on("warning", warn);
  }
  receiver.on("query", (packet, peer) => {
    if (!sameLan(peer.address)) return;
    if (packet.questions?.some((q) => [type, name, host].includes(q.name.replace(/\.$/, ""))))
      announce();
  });
  const timer = setInterval(announce, 60_000);
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    // DNS TTL bounds stale discovery; actual socket closure is the authoritative shutdown.
    await Promise.all(
      sockets.map((socket) => new Promise<void>((resolve) => socket.destroy(resolve))),
    );
    for (const socket of sockets) socket.removeAllListeners();
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve, reject) => {
              const error = () => reject(new Error("lan_mdns_unavailable"));
              socket.once("error", error);
              socket.once("ready", () => {
                socket.removeListener("error", error);
                resolve();
              });
            }),
        ),
      ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("lan_mdns_unavailable")), 5000);
      }),
    ]);
    announce();
    return close;
  } catch {
    await close();
    throw new Error("lan_mdns_unavailable");
  } finally {
    clearTimeout(deadline);
  }
}

export async function listenLan(input: {
  interface: LanInterface;
  accept(token: string, instance: string, socket: WebSocket, signal: AbortSignal): Promise<void>;
  authorize(token: string, instance: string): boolean;
  warn(): void;
  diagnostic?(reason: "source_not_private" | "token_unknown" | "handshake_failed"): void;
  advertise?: typeof advertiseLan;
}) {
  if (!isLanAddress(input.interface.address)) throw new Error("lan_interface_unavailable");
  const instance = randomBytes(16).toString("hex");
  const lifetime = new AbortController();
  let tokens = 16;
  let closing: Promise<void> | undefined;
  const tasks = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  const http = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 },
    (_req, res) => {
      res.writeHead(426, { connection: "close" });
      res.end();
    },
  );
  http.maxConnections = 24;
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  const server = new WebSocketServer({
    server: http,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    backlog: 8,
    verifyClient(info: { origin: string; req: IncomingMessage; secure: boolean }) {
      const token = /^\/link\/([A-Za-z0-9_-]{43})$/.exec(info.req.url ?? "")?.[1];
      const address = http.address();
      const nativeOrigin =
        address && typeof address !== "string"
          ? `http://${input.interface.address}:${address.port}`
          : "";
      const sourceOk = isPrivateLanSource(info.req.socket.remoteAddress ?? "");
      const tokenOk = !!token && input.authorize(token, instance);
      if (!sourceOk) input.diagnostic?.("source_not_private");
      else if (!tokenOk) input.diagnostic?.("token_unknown");
      return (
        !lifetime.signal.aborted &&
        (!info.origin || info.origin === nativeOrigin) &&
        tokens-- > 0 &&
        server.clients.size < 16 &&
        sourceOk &&
        tokenOk
      );
    },
  });
  const refill = setInterval(() => {
    tokens = 16;
  }, 10_000);
  server.on("connection", (socket, request) => {
    // HTTP handshake has finished; the authenticated signaling owner supplies its heartbeat.
    request.socket.setTimeout(0);
    const token = request.url?.slice("/link/".length) ?? "";
    const task = input.accept(token, instance, socket, lifetime.signal).catch((error) => {
      input.diagnostic?.("handshake_failed");
      // Authentication failures reveal neither peer identity nor network payloads.
      socket.terminate();
      if (error instanceof Error && error.message === "drain_unconfirmed") throw error;
    });
    tasks.add(task);
    void task.then(() => tasks.delete(task), input.warn);
  });
  let unpublish: (() => Promise<void>) | undefined;
  const close = () => {
    closing ??= (async () => {
      lifetime.abort();
      clearInterval(refill);
      for (const socket of server.clients) socket.terminate();
      for (const socket of sockets) socket.destroy();
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      const httpStopped = new Promise<void>((resolve) => http.close(() => resolve()));
      const results = await Promise.allSettled([stopped, httpStopped, unpublish?.(), ...tasks]);
      if (results.some((r) => r.status === "rejected")) throw new Error("drain_unconfirmed");
    })();
    return closing;
  };
  server.on("error", () => {
    input.warn();
    void close().catch(input.warn);
  });
  http.on("error", input.warn);
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("listening", () => {
        http.removeListener("error", reject);
        resolve();
      });
      http.once("error", reject);
      http.listen({ host: input.interface.address, port: 0, backlog: 8 });
    });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("lan_listen_failed");
    unpublish = await (input.advertise ?? advertiseLan)(
      { interface: input.interface, port: address.port, instance },
      input.warn,
    );
    return { instance, port: address.port, address: input.interface.address, close };
  } catch {
    await close();
    throw new Error("lan_listen_failed");
  }
}
