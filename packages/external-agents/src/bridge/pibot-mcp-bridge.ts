// The `pibot` MCP server an external agent starts over stdio. It runs inside the
// agent's own sandbox, on Pi Bot's helper Node, and is only a pipe: it hands the session token to
// the brain once, then copies MCP frames both ways. Everything else (the tools, policy, approvals,
// audit) happens in the brain. Node built-ins only: this file runs as its own entry.
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";

const HELLO_LIMIT_MS = 10_000;

const token = process.env.PIBOT_BRIDGE_TOKEN ?? "";
const socketPath = process.env.PIBOT_BRIDGE_SOCKET;
const port = Number(process.env.PIBOT_BRIDGE_PORT ?? "");
// Not left for anything this process might start; the agent already holds it in its config.
delete process.env.PIBOT_BRIDGE_TOKEN;

function fail(reason: string): never {
  // Fixed words on stderr (the agent may show them); never the token.
  process.stderr.write(`pibot bridge: ${reason}\n`);
  process.exit(1);
}

const PROXY_NAMES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/**
 * Linux: the sandbox reaches the host only through its proxy (a URL with its own credentials).
 * Agents start MCP servers with a short environment (Codex keeps PATH, HOME and a few more), so
 * the agent's own environment, which the sandbox set, is read from its process when ours lacks it.
 */
function proxyUrl() {
  for (const name of PROXY_NAMES) if (process.env[name]) return process.env[name];
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    try {
      const vars = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      for (const name of PROXY_NAMES) {
        const entry = vars.find((item) => item.startsWith(`${name}=`));
        if (entry) return entry.slice(name.length + 1);
      }
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      pid = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0);
    } catch {
      // Not readable (another user's process, or no /proc): connect directly below.
      return undefined;
    }
  }
  return undefined;
}

function viaProxy(proxy: string, target: number): Promise<Socket> {
  const url = new URL(proxy);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port || 80), url.hostname);
    const auth = url.username
      ? `Proxy-Authorization: Basic ${Buffer.from(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
        ).toString("base64")}\r\n`
      : "";
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 8192) reject(new Error("proxy_reply"));
        return;
      }
      socket.off("data", onData);
      if (!/^HTTP\/1\.[01] 200/.test(head)) return reject(new Error("proxy_refused"));
      const rest = Buffer.from(head.slice(end + 4), "latin1");
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        `CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n${auth}\r\n`,
      ),
    );
  });
}

function open(): Promise<Socket> {
  if (socketPath)
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath, () => resolve(socket));
      socket.once("error", reject);
    });
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("not configured");
  const proxy = process.platform === "linux" ? proxyUrl() : undefined;
  if (proxy) return viaProxy(proxy, port);
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });
}

if (!/^[a-f0-9]{64}$/.test(token)) fail("not configured");
const timer = setTimeout(() => fail("Pi Bot did not answer"), HELLO_LIMIT_MS);
open().then(
  (socket) => {
    clearTimeout(timer);
    socket.write(`${JSON.stringify({ pibot: "bridge/1", token })}\n`);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    // Pi Bot closes the connection when it refuses the token or the session ends.
    socket.on("close", () => process.exit(0));
    socket.on("error", () => process.exit(1));
    process.stdin.on("end", () => socket.end());
  },
  () => fail("Pi Bot is not reachable"),
);
