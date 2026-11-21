// Seatbelt names a refused socket only by port (`remote:*:5037`, `local:*:5037`), never
// by host. A program that wanted a local service (adb's server on 5037, a database, Ollama) is told
// apart from one that wanted the internet by whether something on this computer listens on that
// loopback port. The probe runs here, outside every sandbox, as a plain connect that is closed at
// once; nothing is sent.
import { connect } from "node:net";

/** `remote:*:5037` / `local:*:5037` in a Seatbelt deny detail. */
const SOCKET_PORT = /\bnetwork-(?:outbound|bind|inbound) (?:remote|local):[^\s]*:(\d{1,5})$/;
const MAX_PORTS = 4;
const PROBE_MS = 200;

function listening(port: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(value);
    };
    const abort = () => done(false);
    const timer = setTimeout(abort, PROBE_MS);
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The ports among `violations` that a local service answers on, at most four probes. */
export async function listeningLoopbackPorts(
  violations: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlySet<number>> {
  const ports = [
    ...new Set(
      violations.flatMap((line) => {
        const port = Number(SOCKET_PORT.exec(line)?.[1]);
        return port > 0 && port <= 65535 ? [port] : [];
      }),
    ),
  ].slice(0, MAX_PORTS);
  const results = await Promise.all(ports.map((port) => listening(port, signal)));
  return new Set(ports.filter((_, index) => results[index]));
}

/**
 * `127.0.0.1:8080`, `localhost:5432`, `[::1]:11434`, or a client's own `tcp:5037` ("daemon not
 * running; starting now at tcp:5037"), in the command line or its output.
 */
const NAMED_PORT = /(?:127\.0\.0\.1|localhost|\[::1\]|\btcp):(\d{1,5})\b/gi;

/** Loopback services `text` names and this computer answers on (see command-run). */
export async function namedLoopbackServices(text: string, signal: AbortSignal) {
  const ports = [
    ...new Set(
      [...text.slice(0, 64 * 1024).matchAll(NAMED_PORT)].flatMap((match) => {
        const port = Number(match[1]);
        return port > 0 && port <= 65535 ? [port] : [];
      }),
    ),
  ].slice(0, MAX_PORTS);
  const results = await Promise.all(ports.map((port) => listening(port, signal)));
  return ports
    .filter((_, index) => results[index])
    .map((port) => ({
      kind: "local_service" as const,
      rule: "loopback_namespace",
      target: `127.0.0.1:${port}`,
    }));
}

/**
 * Clients that bind their socket before connecting, so the sandbox reports only `local:*:0` for
 * them and the port is known from the program alone (its server's report on the port may arrive
 * after the command ended). Measured: adb, the only program in the owner's blocked commands.
 */
const CLIENT_DEFAULT_PORTS: Readonly<
  Record<string, (env: Readonly<Record<string, string | undefined>>) => number>
> = {
  adb: (env) => Number(env.ANDROID_ADB_SERVER_PORT) || 5037,
};

/** `tcp:<port>` hints for known clients the command runs, for namedLoopbackServices. */
export function clientPortHints(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  return [
    ...new Set(
      command
        .split(/[\s;&|()]+/)
        .map((word) => word.split("/").at(-1) ?? "")
        .flatMap((name) => {
          const port = CLIENT_DEFAULT_PORTS[name]?.(env);
          return port && port > 0 && port <= 65535 ? [`tcp:${port}`] : [];
        }),
    ),
  ].join(" ");
}
