import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { SocketLike } from "@pibot/link";
import { isLanAddress, LAN_SERVICE, lanToken } from "@pibot/link/lan";
import { parseRunnerAddress } from "@pibot/link/runner-address";
import multicastDns from "multicast-dns";
import { WebSocket, WebSocketServer } from "ws";

export function listenAddress(value: string) {
  return parseRunnerAddress(value);
}

/** Owns only discovery and sockets; paired-key authentication and business admission live above. */
export async function createRunnerDirect(options: {
  listen: readonly string[];
  key: Uint8Array;
  signal: AbortSignal;
  warn(): void;
}) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const servers: WebSocketServer[] = [];
  const httpServers: Server[] = [];
  const rawSockets = new Set<Socket>();
  const sockets = new Set<WebSocket>();
  const pending = new Set<Promise<void>>();
  const routes = new Map<string, { count: number; at: number }>();
  const addresses = [...new Set(options.listen)].map(listenAddress);
  let waiting: ((socket: WebSocket, path: "address" | "lan") => void) | undefined;
  const token = lanToken(options.key, "00000000000000000000000000000000");
  const own = (socket: WebSocket) => {
    sockets.add(socket);
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => {
        sockets.delete(socket);
        resolve();
      }),
    );
    pending.add(closed);
    void closed.then(() => pending.delete(closed));
    socket.on("error", () => {
      socket.terminate();
    });
  };
  const close = async () => {
    lifetime.abort();
    for (const socket of sockets) socket.terminate();
    for (const socket of rawSockets) socket.destroy();
    await Promise.all(
      httpServers.map((http) => new Promise<void>((resolve) => http.close(() => resolve()))),
    );
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await Promise.all([...pending]);
  };
  signal.addEventListener(
    "abort",
    () => {
      for (const socket of sockets) socket.terminate();
    },
    { once: true },
  );
  try {
    for (const address of addresses) {
      const http = createServer(
        { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 },
        (_request, response) => {
          response.writeHead(426, { connection: "close" });
          response.end();
        },
      );
      http.maxConnections = 24;
      http.on("connection", (socket) => {
        rawSockets.add(socket);
        socket.setTimeout(5000, () => socket.destroy());
        socket.once("close", () => rawSockets.delete(socket));
      });
      http.on("error", options.warn);
      httpServers.push(http);
      const server = new WebSocketServer({
        server: http,
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
        backlog: 8,
        verifyClient(info: { origin: string; req: IncomingMessage; secure: boolean }) {
          const source = info.req.socket.remoteAddress ?? "";
          const now = Date.now();
          for (const [key, value] of routes) if (now - value.at > 10_000) routes.delete(key);
          let rate = routes.get(source);
          if (!rate) {
            if (routes.size >= 256) return false;
            rate = { count: 0, at: now };
            routes.set(source, rate);
          }
          return (
            !signal.aborted &&
            !!waiting &&
            !info.origin &&
            info.req.url === `/link/${token}` &&
            ++rate.count <= 4 &&
            sockets.size < 8
          );
        },
      });
      servers.push(server);
      server.on("connection", (socket, request) => {
        request.socket.setTimeout(0);
        own(socket);
        const accept = waiting;
        if (!accept) socket.terminate();
        else accept(socket, "address");
      });
      server.on("error", options.warn);
      await new Promise<void>((resolve, reject) => {
        http.once("listening", resolve);
        http.once("error", reject);
        http.listen({ host: address.host, port: address.port, backlog: 8 });
      });
    }
  } catch {
    await close();
    throw new Error("runner_listen_failed");
  }
  return {
    addresses: addresses.map((value) => value.address),
    async dial<T>(
      address: string,
      active: AbortSignal,
      authenticate: (socket: SocketLike) => Promise<T>,
    ) {
      let url: URL;
      try {
        url = new URL(address);
        if (url.protocol !== "ws:" || url.username || url.password || !isLanAddress(url.hostname))
          throw new Error("invalid_runner_address");
        if (!/^\/link\/[A-Za-z0-9_-]{43}$/.test(url.pathname))
          throw new Error("invalid_runner_address");
        if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535)
          throw new Error("invalid_runner_address");
      } catch {
        throw new Error("invalid_runner_address");
      }
      const socket = new WebSocket(url, {
        handshakeTimeout: 3000,
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
      });
      own(socket);
      const abort = () => socket.terminate();
      active.addEventListener("abort", abort, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            socket.off("open", open);
            socket.off("error", error);
            socket.off("close", error);
          };
          const open = () => {
            done();
            resolve();
          };
          const error = () => {
            done();
            reject(new Error("runner_address_unavailable"));
          };
          socket.once("open", open);
          socket.once("error", error);
          socket.once("close", error);
          if (active.aborted) error();
        });
        return await authenticate(socket as unknown as SocketLike);
      } finally {
        active.removeEventListener("abort", abort);
        if (active.aborted) socket.terminate();
      }
    },
    async open<T>(
      active: AbortSignal,
      authenticate: (socket: SocketLike, path: "address" | "lan") => Promise<T>,
    ): Promise<T> {
      if (waiting) throw new Error("runner_direct_busy");
      const stop = AbortSignal.any([signal, active]);
      const scanners: ReturnType<typeof multicastDns>[] = [];
      const attempts = new Set<WebSocket>();
      const authentications = new Set<Promise<void>>();
      const seen = new Set<string>();
      let dialAt = Date.now();
      let dials = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      let off = () => {};
      try {
        return await new Promise<T>((resolve, reject) => {
          let done = false;
          const select = (socket: WebSocket, path: "address" | "lan") => {
            if (done || stop.aborted) {
              socket.terminate();
              return;
            }
            attempts.add(socket);
            const work = authenticate(socket as unknown as SocketLike, path).then(
              (value) => {
                if (done || stop.aborted) {
                  socket.terminate();
                  return;
                }
                done = true;
                waiting = undefined;
                attempts.delete(socket);
                resolve(value);
              },
              () => {
                socket.terminate();
              },
            );
            authentications.add(work);
            void work.finally(() => authentications.delete(work)).catch(options.warn);
          };
          waiting = select;
          const abort = () => {
            done = true;
            reject(new Error("runner_direct_cancelled"));
          };
          stop.addEventListener("abort", abort, { once: true });
          off = () => stop.removeEventListener("abort", abort);
          if (stop.aborted) {
            abort();
            return;
          }
          const interfaces = Object.values(networkInterfaces())
            .flatMap((v) => v ?? [])
            .filter((v) => v.family === "IPv4" && !v.internal && isLanAddress(v.address))
            .slice(0, 8);
          for (const network of interfaces) {
            const mdns = multicastDns({ interface: network.address });
            scanners.push(mdns);
            mdns.on("error", options.warn);
            mdns.on("warning", options.warn);
            mdns.on("response", (packet) => {
              if (Date.now() - dialAt >= 10_000) {
                dialAt = Date.now();
                dials = 0;
              }
              if (done || seen.size >= 32 || dials >= 16) return;
              const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
              for (const srv of records) {
                if (srv.type !== "SRV" || !srv.name.endsWith(`._${LAN_SERVICE}._tcp.local`))
                  continue;
                const instance = srv.name.split(".")[0] ?? "";
                if (
                  !/^[a-f0-9]{32}$/.test(instance) ||
                  !Number.isInteger(srv.data.port) ||
                  srv.data.port < 1 ||
                  srv.data.port > 65535
                )
                  continue;
                for (const record of records) {
                  if (
                    record.type !== "A" ||
                    record.name !== srv.data.target ||
                    !isLanAddress(record.data)
                  )
                    continue;
                  const url = `ws://${record.data}:${srv.data.port}/link/${lanToken(options.key, instance)}`;
                  if (seen.has(url) || seen.size >= 32 || attempts.size >= 4 || dials >= 16)
                    continue;
                  dials++;
                  seen.add(url);
                  const socket = new WebSocket(url, {
                    handshakeTimeout: 3000,
                    maxPayload: 1024 * 1024,
                    perMessageDeflate: false,
                  });
                  own(socket);
                  attempts.add(socket);
                  socket.once("open", () => select(socket, "lan"));
                  socket.once("close", () => {
                    attempts.delete(socket);
                    seen.delete(url);
                  });
                }
              }
            });
          }
          const query = () => {
            for (const mdns of scanners)
              mdns.query({ questions: [{ name: `_${LAN_SERVICE}._tcp.local`, type: "PTR" }] });
          };
          timer = setInterval(query, 1000);
          query();
        });
      } finally {
        off();
        waiting = undefined;
        clearInterval(timer);
        const losing = [...attempts];
        const drained = losing.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.readyState === WebSocket.CLOSED) resolve();
              else socket.once("close", () => resolve());
            }),
        );
        for (const socket of losing) socket.terminate();
        await Promise.all(drained);
        await Promise.allSettled([...authentications]);
        await Promise.all(
          scanners.map((mdns) => new Promise<void>((resolve) => mdns.destroy(resolve))),
        );
      }
    },
    close,
  };
}
