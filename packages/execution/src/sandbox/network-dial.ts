import { connect, isIP, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

function connected(socket: Socket, event: "connect" | "secureConnect", signal: AbortSignal) {
  return new Promise<Socket>((resolve, reject) => {
    const abort = () => socket.destroy(new Error("cancelled"));
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.off("error", fail);
      socket.off("close", fail);
      socket.off(event, ready);
    };
    const fail = () => {
      cleanup();
      reject(new Error("connection_failed"));
    };
    const ready = () => {
      cleanup();
      resolve(socket);
    };
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once(event, ready);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Only the user's explicit upstream is trusted; never consult ambient proxy variables. */
export async function dialTarget(input: {
  host: string;
  address: string;
  port: number;
  upstream?: string;
  signal: AbortSignal;
  track(socket: Socket): void;
}) {
  const { signal, track } = input;
  if (!input.upstream) {
    const socket = connect({ host: input.address, port: input.port });
    track(socket);
    return connected(socket, "connect", signal);
  }
  const proxy = new URL(input.upstream);
  if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("invalid_proxy");
  const tls = proxy.protocol === "https:";
  const host = proxy.hostname.replace(/^\[|\]$/g, "");
  const options = {
    host,
    port: Number(proxy.port || (tls ? 443 : 80)),
    ...(tls && !isIP(host) ? { servername: host } : {}),
  };
  const socket = tls ? connectTls(options) : connect(options);
  track(socket);
  await connected(socket, tls ? "secureConnect" : "connect", signal);
  const authority = `${input.host.includes(":") ? `[${input.host}]` : input.host}:${input.port}`;
  const auth =
    proxy.username || proxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
      : "";
  return new Promise<Socket>((resolve, reject) => {
    let header = Buffer.alloc(0);
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.off("data", data);
      socket.off("error", fail);
      socket.off("end", fail);
      socket.off("close", fail);
    };
    const fail = () => {
      cleanup();
      socket.destroy();
      reject(new Error("proxy_unavailable"));
    };
    const abort = () => fail();
    const data = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) {
        if (header.length > 16384) fail();
        return;
      }
      if (end > 16384 || !/^HTTP\/1\.[01] 200(?: |\r)/.test(header.toString("latin1", 0, end)))
        return fail();
      cleanup();
      socket.pause();
      if (header.length > end + 4) socket.unshift(header.subarray(end + 4));
      resolve(socket);
    };
    socket.on("data", data);
    socket.once("error", fail);
    socket.once("end", fail);
    socket.once("close", fail);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
  });
}
