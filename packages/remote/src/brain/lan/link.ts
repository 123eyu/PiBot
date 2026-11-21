import type { DirectDiagnosticSink, LinkPath, RtcPeerFactory } from "@pibot/link";
import { RunnerDrainError, runnerRetryDelay, unbase64, waitRunnerRetry } from "@pibot/link";
import { firstConnection, lanToken } from "@pibot/link/lan";
import { z } from "zod";
import type { LinkSession, RemoteLinkPort } from "../link/port.ts";
import { acceptRunnerDirect, dialRunnerAddress } from "../link/runner-direct.ts";
import { type LanInterface, lanInterfaces, listenLan } from "./listener.ts";
import { acceptLanSession, type LanConnect } from "./session.ts";

const Secret = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
interface Waiting {
  input: LanConnect;
  key: Uint8Array;
  active?: AbortSignal;
  resolve?(session: LinkSession): void;
  upgrade?(session: LinkSession): Promise<void>;
  busy: boolean;
  work?: Promise<void>;
  off?(): void;
}
export interface LanLinkOptions {
  createPeer?: RtcPeerFactory;
  onDirectDiagnostic?: DirectDiagnosticSink;
  /** `suppressed`: how many more of the same rejection the last minute held back. */
  warn(reason?: string, suppressed?: number): void;
  /** Controlled probes inject private interfaces and an announcement recorder, never a wildcard. */
  interfaces?: () => LanInterface[];
  advertise?: Parameters<typeof listenLan>[0]["advertise"];
}

/**
 * An address dial is retried with the runner backoff until the race ends: beside a LAN wait that
 * never fails, a single refused dial used to leave a listener that came back unused (F3).
 */
async function dialWithRetry(
  address: string,
  input: Parameters<typeof dialRunnerAddress>[1],
): Promise<LinkSession> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await dialRunnerAddress(address, input);
    } catch (error) {
      if (input.signal.aborted || error instanceof RunnerDrainError) throw error;
      await waitRunnerRetry(runnerRetryDelay(attempt), input.signal);
      input.signal.throwIfAborted();
    }
  }
}

function pathOf(session: LinkSession, fallback: LinkPath["path"]): LinkPath {
  return (
    session.currentPath?.() ?? {
      port: session.port,
      path: fallback,
      closed: session.signal ?? new AbortController().signal,
    }
  );
}

function upgradeable(selected: LinkSession, entry: Waiting, fallback: LinkPath["path"]) {
  fallback = selected.currentPath?.().path ?? fallback;
  if (fallback !== "relay") {
    entry.active = selected.signal ?? entry.input.signal;
    entry.upgrade = undefined;
    return selected;
  }
  const active = { current: selected };
  const relaySignal = selected.signal;
  let upgraded: LinkSession | undefined;
  let closed = false;
  const listeners = new Set<(path: LinkPath) => Promise<void>>();
  /**
   * Each wrapped session also switches its own physical paths (WebRTC direct, fallback, relay
   * reconnect) and its PathSession waits for the business rebind before it acknowledges a switch.
   * Phone test 2026-11-15: these changes were not forwarded, so after `path_selected direct` the
   * computer kept answering on the deselected relay endpoint (`direct_traffic tx=0`), the phone's
   * bind timed out, and the retired relay gateway then refused the relay rebind too.
   */
  const follow = (session: LinkSession) =>
    session.onPath?.(async (path) => {
      if (closed || active.current !== session) return;
      for (const listener of [...listeners]) await listener(path);
    });
  let offSelected: (() => void) | undefined;
  let offUpgraded: (() => void) | undefined;
  const proxy: LinkSession = {
    get port() {
      return active.current.port;
    },
    signal: selected.signal,
    keepalive: selected.keepalive,
    currentPath: () => pathOf(active.current, fallback),
    onPath(listener) {
      listeners.add(listener);
      // Subscribed with the owner's first listener: it binds the current path before this.
      offSelected ??= follow(selected);
      return () => listeners.delete(listener);
    },
    onPresence: (listener) => selected.onPresence(listener),
    onDirectFailure: (listener) => selected.onDirectFailure?.(listener) ?? (() => {}),
    endReason: () => active.current.endReason?.() ?? selected.ended?.()?.reason,
    close: async (reason) => {
      if (closed) return;
      closed = true;
      entry.active = undefined;
      offSelected?.();
      offUpgraded?.();
      const results = await Promise.allSettled([
        selected.close(reason),
        ...(upgraded && upgraded !== selected ? [upgraded.close(reason)] : []),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
  entry.upgrade = async (next) => {
    if (closed) return next.close();
    upgraded = next;
    active.current = next;
    offUpgraded?.();
    offUpgraded = undefined;
    for (const listener of listeners) await listener(pathOf(next, "direct"));
    if (!closed && active.current === next) offUpgraded = follow(next);
    next.signal?.addEventListener(
      "abort",
      () => {
        if (upgraded === next) {
          offUpgraded?.();
          offUpgraded = undefined;
        }
        if (active.current !== next || relaySignal?.aborted) return;
        active.current = selected;
        for (const listener of listeners) void listener(pathOf(selected, fallback));
      },
      { once: true },
    );
  };
  entry.active = AbortSignal.any([entry.input.signal, ...(relaySignal ? [relaySignal] : [])]);
  entry.busy = false;
  return proxy;
}

/** One listener owner per remote service; individual paired devices own their accepted sessions. */
export function createLanRemoteLink(base: RemoteLinkPort, options: LanLinkOptions): RemoteLinkPort {
  const entries = new Set<Waiting>();
  let enabled = false;
  let failed = false;
  let tail = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let listeners: Awaited<ReturnType<typeof listenLan>>[] = [];
  let signature = "";
  let warned = 0;
  const warn = () => {
    if (Date.now() - warned < 30_000) return;
    warned = Date.now();
    options.warn();
  };
  const drain = async () => {
    const current = listeners;
    const results = await Promise.allSettled(current.map((listener) => listener.close()));
    listeners = current.filter((_, i) => results[i]?.status === "rejected");
    if (listeners.length) throw new Error("drain_unconfirmed");
  };
  const find = (token: string, instance: string) =>
    [...entries].find(
      (entry) =>
        (entry.resolve || entry.upgrade) &&
        entry.active &&
        !entry.active.aborted &&
        !entry.busy &&
        lanToken(entry.key, instance) === token,
    );
  // Rejected connections are logged per reason at most once a minute with a count: a stale
  // pairing retrying the LAN port wrote one warning per attempt (4,807 lines on 2026-11-17).
  const rejected = new Map<string, { since: number; count: number }>();
  const diagnostic = (reason: string) => {
    const now = Date.now();
    const entry = rejected.get(reason);
    if (entry && now - entry.since < 60_000) {
      entry.count++;
      return;
    }
    const suppressed = entry ? entry.count : 0;
    rejected.set(reason, { since: now, count: 0 });
    options.warn(`lan_${reason}`, suppressed || undefined);
  };
  const refresh = () => {
    const next = tail.then(async () => {
      const interfaces = enabled && !failed ? (options.interfaces ?? lanInterfaces)() : [];
      const current = JSON.stringify(interfaces);
      if (current === signature && listeners.length) return;
      await drain();
      signature = "";
      for (const network of interfaces) {
        try {
          listeners.push(
            await listenLan({
              interface: network,
              warn,
              diagnostic,
              advertise: options.advertise,
              authorize: (token, instance) => !!find(token, instance),
              accept(token, instance, socket) {
                const entry = find(token, instance);
                if (!entry?.active) return Promise.reject(new Error("lan_unknown_peer"));
                const active = entry.active;
                entry.busy = true;
                const work = (async () => {
                  try {
                    const session =
                      entry.input.kind === "runner"
                        ? await acceptRunnerDirect(
                            socket,
                            { ...entry.input, signal: active },
                            "lan",
                          )
                        : await acceptLanSession(
                            socket,
                            entry.input,
                            options.createPeer ??
                              (() => {
                                throw new Error("rtc_unavailable");
                              }),
                            active,
                            options.onDirectDiagnostic,
                          );
                    if (active.aborted || (!entry.resolve && !entry.upgrade)) {
                      await session.close();
                      return;
                    }
                    if (entry.upgrade) await entry.upgrade(session);
                    else {
                      const resolve = entry.resolve;
                      entry.resolve = undefined;
                      entry.off?.();
                      resolve?.(session);
                    }
                  } finally {
                    entry.busy = false;
                  }
                })();
                entry.work = work;
                return work;
              },
            }),
          );
        } catch (error) {
          if (error instanceof Error && error.message === "drain_unconfirmed") throw error;
          // A virtual/disconnected NIC must not disable discovery on the other private NICs.
          warn();
        }
      }
      signature = current;
    });
    const settled = next.catch(async () => {
      failed = true;
      warn();
      await drain();
    });
    tail = settled.catch(() => {
      /* Retained listeners are retried by the next explicit drain. */
    });
    return settled;
  };
  return {
    ...base,
    async configureLan(value) {
      enabled = value;
      clearInterval(timer);
      timer = value
        ? setInterval(() => {
            void refresh().catch(warn);
          }, 5000)
        : undefined;
      // A deliberate settings change can retry a previously failed bind.
      failed = false;
      await refresh();
    },
    async connectRunnerDirect(input) {
      const key = unbase64(Secret.parse(JSON.parse(input.roomSecret)).key, 32);
      const entry: Waiting = {
        input: { ...input, kind: "runner", room: "", relayUrl: "" },
        key,
        busy: false,
      };
      if (enabled) entries.add(entry);
      const remove = async () => {
        entry.off?.();
        entries.delete(entry);
        key.fill(0);
        await refresh();
      };
      try {
        const selected = await firstConnection<LinkSession>(
          [
            ...(input.punch ? [input.punch] : []),
            ...input.addresses
              .slice(0, 8)
              .map(
                (address) => (signal: AbortSignal) => dialWithRetry(address, { ...input, signal }),
              ),
            ...(enabled
              ? [
                  (signal: AbortSignal) =>
                    new Promise<LinkSession>((resolve, reject) => {
                      entry.active = signal;
                      entry.resolve = resolve;
                      const abort = () => {
                        entry.resolve = undefined;
                        void Promise.resolve(entry.work).then(
                          () => reject(new Error("lan_cancelled")),
                          reject,
                        );
                      };
                      entry.off = () => signal.removeEventListener("abort", abort);
                      signal.addEventListener("abort", abort, { once: true });
                      void refresh().catch(reject);
                      if (signal.aborted) abort();
                    }),
                ]
              : []),
          ],
          input.signal,
        );
        // Every candidate here is already direct, and the relay generation's upgrade is owned by
        // RunnerConnections. Wrapping it in the phone's upgrade proxy dropped select/activate and
        // runnerPath, so the desktop "selected" an unadmitted port and every post threw
        // runner_not_admitted (v0.0.2 Linux runner on the relay, 2026-11-13).
        return {
          ...selected,
          async close(reason) {
            try {
              await selected.close(reason);
            } finally {
              await remove();
            }
          },
        };
      } catch (error) {
        await remove();
        throw error;
      }
    },
    lanAddresses(roomSecret: string) {
      let key: Uint8Array;
      try {
        const parsed = Secret.safeParse(JSON.parse(roomSecret));
        key = parsed.success ? unbase64(parsed.data.key, 32) : unbase64(roomSecret, 32);
      } catch {
        return [];
      }
      try {
        return listeners.map(
          (listener) =>
            `ws://${listener.address}:${listener.port}/link/${lanToken(key, listener.instance)}`,
        );
      } finally {
        key.fill(0);
      }
    },
    async connect(input) {
      if (!enabled || input.kind === "runner") return base.connect(input);
      const key = unbase64(Secret.parse(JSON.parse(input.roomSecret)).key, 32);
      const entry: Waiting = { input, key, busy: false };
      entries.add(entry);
      const remove = async () => {
        entry.off?.();
        entries.delete(entry);
        key.fill(0);
        await refresh();
      };
      try {
        const selected = await firstConnection<LinkSession>(
          [
            (signal) => base.connect({ ...input, signal }),
            (signal) =>
              new Promise<LinkSession>((resolve, reject) => {
                entry.active = signal;
                entry.resolve = resolve;
                const abort = () => {
                  entry.resolve = undefined;
                  void Promise.resolve(entry.work).then(
                    () => reject(new Error("lan_cancelled")),
                    (error) =>
                      reject(
                        error instanceof Error && error.message === "drain_unconfirmed"
                          ? error
                          : new Error("lan_cancelled"),
                      ),
                  );
                };
                entry.off = () => signal.removeEventListener("abort", abort);
                signal.addEventListener("abort", abort, { once: true });
                void refresh().catch((error) => {
                  entry.resolve = undefined;
                  reject(error);
                });
                if (signal.aborted) abort();
              }),
          ],
          input.signal,
          { failFast: (index) => index === 0 },
        );
        let closing: Promise<void> | undefined;
        const proxy = upgradeable(selected, entry, "relay");
        return {
          ...proxy,
          get port() {
            return proxy.port;
          },
          close(reason) {
            closing ??= (async () => {
              try {
                await proxy.close(reason);
              } finally {
                entry.upgrade = undefined;
                await remove();
              }
            })();
            return closing;
          },
        };
      } catch (error) {
        await remove();
        throw error;
      }
    },
  };
}
