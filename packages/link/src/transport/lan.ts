import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Port } from "@pibot/protocol-base";
import { base64url, LinkError, utf8 } from "../core/bytes.ts";
import type { LinkWire } from "./path-endpoint.ts";
import { PathSession, type PathSessionOptions } from "./path-session.ts";
import { createRunnerDrain, RunnerDrainError } from "./runner-retry.ts";

export const LAN_SERVICE = "pibot-link";
export const LAN_PROLOGUE = utf8("pibot-link-lan-v1");

/** Discovery is untrusted; never turn a DNS-SD response into a public-network request. */
export function isLanAddress(value: string) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const octets = value.split(".").map(Number);
  if (octets.some((n, i) => n > 255 || String(n) !== value.split(".")[i])) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Rotating routing hints prove no identity; Noise still authenticates both paired keys. */
export function lanToken(key: Uint8Array, instance: string) {
  if (key.length !== 32) throw new LinkError("invalid_lan_key");
  // DNS labels are case-insensitive: lowercase hex avoids changing the routing commitment.
  if (!/^[0-9a-f]{32}$/.test(instance)) throw new LinkError("invalid_lan_instance");
  return base64url(hmac(sha256, key, utf8(`pibot-lan-route-v1:${instance}`)));
}

/** The LAN socket is signaling-only. Business is released only after the direct commit. */
export async function lanPathSession(options: PathSessionOptions): Promise<PathSession> {
  const lifetime = new AbortController();
  const session = new PathSession({
    ...options,
    signal: AbortSignal.any([options.signal, lifetime.signal]),
  });
  session.onChange(async (path) => {
    if (path.path === "direct") return;
    // A LAN signaling socket must never become the fallback business path.
    lifetime.abort();
    throw new LinkError("lan_direct_closed");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.any([session.closed, AbortSignal.timeout(25_000)]);
      const abort = () => {
        off();
        reject(new LinkError("lan_upgrade_failed"));
      };
      const off = session.onChange(async (path) => {
        if (path.path !== "direct") return;
        off();
        signal.removeEventListener("abort", abort);
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

export function signalingWire(wire: LinkWire): LinkWire {
  const port: Port = {
    post: (message) => wire.port.post(message),
    onMessage: (listener) =>
      wire.port.onMessage((message) => {
        const value = message as { method?: unknown; id?: unknown; jsonrpc?: unknown } | null;
        if (
          value?.jsonrpc !== "2.0" ||
          typeof value.method !== "string" ||
          !/^link\.(direct|path)\./.test(value.method) ||
          value.id !== undefined
        ) {
          wire.port.dispose?.();
          return;
        }
        listener(message);
      }),
  };
  return { ...wire, port };
}

/** A successful branch owns its lifetime; every losing socket/scan must finish closing first. */
export async function firstConnection<T extends { close(): Promise<void> }>(
  branches: ((signal: AbortSignal) => Promise<T>)[],
  signal: AbortSignal,
  options: { failFast?: (index: number, error: unknown) => boolean } = {},
): Promise<T> {
  const controllers: AbortController[] = [];
  const tasks = branches.map((open) => {
    const controller = new AbortController();
    controllers.push(controller);
    return open(AbortSignal.any([signal, controller.signal]));
  });
  let winner: T | undefined;
  try {
    const selected = await Promise.any(
      tasks.map(async (work, index) => {
        try {
          return { value: await work, index };
        } catch (error) {
          // Retiring a loser is expected after selection, not failure of the chosen path.
          if (
            winner === undefined &&
            !signal.aborted &&
            !controllers[index]?.signal.aborted &&
            options.failFast?.(index, error)
          ) {
            for (const controller of controllers) controller.abort();
            throw error;
          }
          throw error;
        }
      }),
    );
    winner = selected.value;
    controllers.forEach((c, i) => {
      if (i !== selected.index) c.abort();
    });
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "fulfilled" && result.value !== winner) await result.value.close();
      if (
        result.status === "rejected" &&
        result.reason instanceof Error &&
        (result.reason.message === "drain_unconfirmed" || result.reason instanceof RunnerDrainError)
      )
        throw result.reason;
    }
    signal.throwIfAborted();
    // A branch that completed late after a genuine fail-fast cancellation is not a live winner.
    if (controllers[selected.index]?.signal.aborted) throw new LinkError("connection_unavailable");
    return winner;
  } catch {
    controllers.forEach((c) => {
      c.abort();
    });
    const results = await Promise.allSettled(tasks);
    await createRunnerDrain(
      results.flatMap((r) =>
        r.status === "fulfilled"
          ? [() => r.value.close()]
          : r.reason instanceof RunnerDrainError
            ? [r.reason.retry]
            : [],
      ),
      signal,
      () => {},
    )();
    if (
      results.some(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof Error &&
          r.reason.message === "drain_unconfirmed",
      )
    )
      throw new LinkError("drain_unconfirmed");
    const reason = results.find(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof Error &&
        ["remote_room_empty", "remote_session_timeout", "relay_unavailable"].includes(
          result.reason.message,
        ),
    );
    if (reason?.status === "rejected") throw new LinkError(reason.reason.message);
    throw new LinkError("connection_unavailable");
  }
}
