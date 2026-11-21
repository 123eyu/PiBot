import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { connectRunnerSocket, type EndpointKeys, type SocketLike } from "@pibot/link";
import { isLanAddress, LAN_SERVICE } from "@pibot/link/lan";
import multicastDns from "multicast-dns";
import { type WebSocket, WebSocketServer } from "ws";

/** The opaque route only selects a grant; Noise still proves the phone's signed public key. */
export async function openPhoneLan(options: {
  instance: string;
  token: string;
  keys: EndpointKeys;
  phone: string;
  signature: string;
  signal: AbortSignal;
  allowed(): boolean;
  warn(): void;
}) {
  const http = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 },
    (_req, res) => res.writeHead(426).end(),
  );
  http.maxConnections = 8;
  const sockets = new Set<WebSocket>();
  const raw = new Set<import("node:net").Socket>();
  const pending = new Set<Promise<void>>();
  const scanners: ReturnType<typeof multicastDns>[] = [];
  let closed = false;
  let selected = false;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  let resolve!: (value: Awaited<ReturnType<typeof connectRunnerSocket>>) => void;
  let reject!: (error: Error) => void;
  const candidate = new Promise<Awaited<ReturnType<typeof connectRunnerSocket>>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void candidate.catch(() => {});
  const abort = () => {
    reject(new Error("phone_lan_closed"));
    for (const s of sockets) s.terminate();
    for (const s of raw) s.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  http.on("connection", (s) => {
    raw.add(s);
    s.setTimeout(5000, () => s.destroy());
    s.once("close", () => raw.delete(s));
  });
  const server = new WebSocketServer({
    server: http,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    verifyClient: ({ req, origin }: { req: import("node:http").IncomingMessage; origin: string }) =>
      !signal.aborted &&
      !origin &&
      options.allowed() &&
      req.url === `/link/${options.token}` &&
      sockets.size < 4,
  });
  server.on("error", () => {
    lifetime.abort();
  });
  server.on("connection", (socket, request) => {
    request.socket.setTimeout(0);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.terminate());
    const work = (async () => {
      let session: Awaited<ReturnType<typeof connectRunnerSocket>> | undefined;
      try {
        session = await connectRunnerSocket(socket as unknown as SocketLike, {
          keys: options.keys,
          publicKey: options.phone,
          role: "initiator",
          signal,
          random: randomBytes,
          authorizationSignature: options.signature,
        });
        await session.selected();
        if (!options.allowed() || selected) throw new Error("desktop_priority");
        selected = true;
        resolve(session);
      } catch {
        await session?.close();
        socket.terminate();
      }
    })();
    pending.add(work);
    void work.catch(() => lifetime.abort()).finally(() => pending.delete(work));
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    signal.removeEventListener("abort", abort);
    await Promise.all(scanners.map((s) => new Promise<void>((done) => s.destroy(() => done()))));
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => http.close(() => done()));
    await Promise.all(pending);
  };
  try {
    await new Promise<void>((yes, no) => {
      http.once("error", no);
      http.listen(0, "0.0.0.0", () => {
        http.off("error", no);
        yes();
      });
    });
    signal.throwIfAborted();
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("phone_lan_unavailable");
    const type = `_${LAN_SERVICE}._tcp.local`;
    const name = `${options.instance}.${type}`;
    const host = `${options.instance}.local`;
    for (const nic of Object.values(networkInterfaces())
      .flatMap((v) => v ?? [])
      .filter((v) => v.family === "IPv4" && !v.internal && isLanAddress(v.address))
      .slice(0, 8)) {
      const scanner = multicastDns({ interface: nic.address });
      scanners.push(scanner);
      scanner.on("error", options.warn);
      scanner.on("warning", options.warn);
      const announce = () => {
        if (closed || signal.aborted) return;
        scanner.respond([
          { name: type, type: "PTR", ttl: 30, data: name },
          {
            name,
            type: "SRV",
            ttl: 30,
            data: { port: address.port, target: host, priority: 0, weight: 0 },
          },
          { name, type: "TXT", ttl: 30, data: [Buffer.from("v=1")] },
          { name: host, type: "A", ttl: 30, data: nic.address },
        ]);
      };
      scanner.on("query", (packet) => {
        if (packet.questions.some((q) => [type, name, host].includes(q.name))) announce();
      });
      announce();
    }
    return { candidate, close };
  } catch (error) {
    await close();
    throw error;
  }
}
