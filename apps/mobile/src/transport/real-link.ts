import {
  base64url,
  type DirectDiagnostic,
  DirectSkipped,
  destroyEndpoint,
  dhPublic,
  encryptedPort,
  endpointKeys,
  establishDirectNoise,
  establishNoise,
  type LinkWire,
  negotiateDirect,
  PathSession,
  type PathSessionOptions,
  type RandomBytes,
  ROOM_PERIOD_MS,
  type RtcPeerFactory,
  roomTicket,
  type SocketConstructor,
  unbase64,
} from "@pibot/link";
import { firstConnection } from "@pibot/link/lan";
import { type Credential, readCredential } from "./credential.ts";
import {
  reportDirectDiagnostic,
  reportLinkEvent,
  reportLinkFailure,
  reportPathEvent,
} from "./diagnostics.ts";
import { connectLan, type LanDiscover } from "./lan-link.ts";
import type { Computer, LinkConnection, MobileLink } from "./link-port.ts";
import { mobileNetworkHint, type PhoneNetwork, phoneNetwork } from "./network-hint.ts";
import { pairChannel } from "./pair-channel.ts";
import { portConnection } from "./port-connection.ts";
import { openPhoneRoom } from "./relay-room.ts";

// Node relay probes and existing sessions must not load a native module until T4 requests RTC.
export const createMobileRtcPeer: RtcPeerFactory = async (options) => {
  options.signal.throwIfAborted();
  const { createNativeMobileRtcPeer } = await import("./rtc-peer.ts");
  options.signal.throwIfAborted();
  return createNativeMobileRtcPeer(options);
};

const waitForLanWindow = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => finish();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(finish, 1500);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish();
  });

interface Options {
  WebSocket: SocketConstructor;
  random: RandomBytes;
  /** Probes can inject a pure TS factory without loading native WebRTC. */
  createRtcPeer?: RtcPeerFactory;
  discoverLan?: LanDiscover;
}
async function relayWire(
  options: Options,
  credential: Credential,
  signal: AbortSignal,
  timeoutMs: number,
  /** See openPhoneRoom: resumes fail over after 5 s; the first session after pairing waits. */
  presenceMs?: number,
): Promise<LinkWire> {
  const seed = unbase64(credential.seed, 32);
  const keys = endpointKeys(seed);
  seed.fill(0);
  const key = unbase64(credential.roomKey, 32);
  let room: Awaited<ReturnType<typeof openPhoneRoom>> | undefined;
  let port: ReturnType<typeof encryptedPort> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ticket = roomTicket(key);
    room = await openPhoneRoom(
      options.WebSocket,
      credential.relay,
      ticket,
      signal,
      timeoutMs,
      presenceMs,
    );
    // The handshake deadline never becomes the established connection's lifetime.
    const handshakeAt = Date.now();
    const channel = await establishNoise(room.transport, {
      role: "initiator",
      staticSecret: keys.dhSecret,
      remoteStatic: dhPublic(unbase64(credential.publicKey, 32)),
      random: options.random,
      signal: room.signal,
      timeoutMs: Math.min(timeoutMs, 5_000),
    });
    reportLinkEvent("connect_stage", { stage: "noise_ready", ms: Date.now() - handshakeAt });
    port = encryptedPort(channel, room.transport, { signal: room.signal });
    const current = room;
    const activePort = port;
    let closing: Promise<void> | undefined;
    const close = (reason?: string) => {
      closing ??= (async () => {
        clearTimeout(timer);
        activePort.dispose?.();
        await current.close(reason);
      })();
      return closing;
    };
    current.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    // A day boundary changes the ticket. Retire this Peer before rejoining the new room.
    timer = setTimeout(
      () => {
        void close("room_rotated").catch(() => {
          /* The owner still awaits the same rejected drain receipt before reconnecting. */
        });
      },
      (ticket.period + 1) * ROOM_PERIOD_MS - Date.now() + 20,
    );
    return { port, closed: current.signal, close: () => close(), reason: current.reason };
  } catch (error) {
    clearTimeout(timer);
    port?.dispose?.();
    await room?.close();
    throw error;
  } finally {
    destroyEndpoint(keys);
    key.fill(0);
  }
}

async function connect(
  options: Options,
  credential: Credential,
  signal: AbortSignal,
  timeoutMs: number,
  waitForComputerMs?: number,
  allowDirect = true,
) {
  // Cursor reuse is safe within this continuous authenticated owner; a reconnect gets a new ID.
  const epoch = `link:${base64url(options.random(16))}`;
  // Initial self/resume completes before onChange allows an upgrade; legacy metadata stays LAN-only.
  let stunUrl: string | undefined;
  // Rejoins inside an established session keep the short presence wait (fail over fast).
  const reconnect = (active: AbortSignal) => relayWire(options, credential, active, timeoutMs);
  // Without a factory the session never offers an upgrade; the computer only ever answers one.
  // PathSession retries a failed attempt with a growing delay for as long as the relay carries
  // the session (maintainers 2026-11-13 / 2026-11-15: direct first on any network, VPN or not).
  const upgrade: Pick<PathSessionOptions, "direct"> = {
    async direct(port, active) {
      const net = await phoneNetwork(credential.lanAddresses, active);
      // Without STUN only host candidates exist; on cellular without a VPN none of them can pair.
      // A VPN may route to the computer (its tunnel address is a host candidate), so it is tried.
      const skip =
        net?.kind === "none"
          ? "no_network"
          : net?.kind === "cellular" && !net.vpn && !stunUrl
            ? "no_stun"
            : undefined;
      if (skip) {
        reportLinkEvent("direct_skipped", { reason: skip });
        throw new DirectSkipped();
      }
      reportLinkEvent("direct_attempt", {
        network: net?.kind ?? "unknown",
        vpn: net?.vpn ? 1 : 0,
        stun: stunUrl ? 1 : 0,
      });
      return attemptDirect(port, active, net);
    },
  };
  async function attemptDirect(
    port: Parameters<NonNullable<PathSessionOptions["direct"]>>[0],
    active: AbortSignal,
    net: PhoneNetwork | undefined,
  ) {
    // The VPN advice ("bypass LAN") only explains a failure where a LAN path was possible.
    const hint = !net
      ? await mobileNetworkHint(active)
      : net.vpn && net.kind !== "cellular"
        ? ("peer_vpn_active" as const)
        : undefined;
    // Diagnostics only: the last bad ICE state names why an open direct path ended.
    let ice: string | undefined;
    const onDiagnostic = (event: DirectDiagnostic) => {
      if ((event.event === "ice" || event.event === "connection") && event.state !== "closed")
        ice = event.state === "failed" || event.state === "disconnected" ? event.state : undefined;
      reportDirectDiagnostic(event);
    };
    const data = await negotiateDirect({
      failureHint: () => hint,
      onDiagnostic,
      port,
      createPeer: (rtc) => (options.createRtcPeer ?? createMobileRtcPeer)({ ...rtc, stunUrl }),
      role: "initiator",
      signal: active,
    });
    // Any pair kind is taken (same network or through the internet); PathSession proves it with
    // small and large round trips before the switch (path-probe.ts), which is what the hole-punched
    // 5G path of the v0.0.2 test would have failed.
    const seed = unbase64(credential.seed, 32);
    const keys = endpointKeys(seed);
    seed.fill(0);
    try {
      const { transport, channel } = await establishDirectNoise(data, {
        role: "initiator",
        staticSecret: keys.dhSecret,
        remoteStatic: dhPublic(unbase64(credential.publicKey, 32)),
        random: options.random,
        signal: active,
      });
      const encrypted = encryptedPort(channel, transport, { signal: active });
      return {
        port: encrypted,
        closed: transport.closed,
        pathKind: data.pathKind,
        ...(data.pathStats ? { stats: data.pathStats } : {}),
        async close() {
          encrypted.dispose?.();
        },
        reason: () =>
          ice === "failed"
            ? "direct_ice_failed"
            : ice === "disconnected"
              ? "direct_ice_disconnected"
              : "direct_channel_closed",
      };
    } finally {
      destroyEndpoint(keys);
    }
  }
  const session = new PathSession({
    onDiagnostic: reportDirectDiagnostic,
    onEvent: reportPathEvent,
    relay: await relayWire(options, credential, signal, timeoutMs, waitForComputerMs),
    reconnect,
    signal,
    role: "initiator",
    ...(allowDirect ? upgrade : {}),
  });
  if (!allowDirect) reportLinkEvent("direct_skipped", { reason: "paused" });
  let selected: LinkConnection | undefined;
  const upgradeListeners = new Set<(connection: LinkConnection) => Promise<void>>();
  let lanAttempt: AbortController | undefined;
  let lanRetry: ReturnType<typeof setTimeout> | undefined;
  let lanRetries = 0;
  // Off the computer's subnet the LAN socket only works through a routed VPN: ask less often.
  let lanFar = false;
  // An attempt still running when the session ended used to reschedule itself forever (two
  // "lan_upgrade unavailable" per minute per past session in the v0.0.2 phone log).
  const ended = () => signal.aborted || session.closed.aborted;
  const scheduleLan = (delay: number) => {
    if (!credential.lanAddresses.length || ended() || selected !== relay) return;
    clearTimeout(lanRetry);
    lanRetry = setTimeout(() => {
      lanRetry = undefined;
      void tryLanUpgrade();
    }, delay);
  };
  const tryLanUpgrade = async () => {
    if (!credential.lanAddresses.length || ended() || selected !== relay || lanAttempt) return;
    const attempt = new AbortController();
    lanAttempt = attempt;
    try {
      const current = session.current();
      if (current.path === "direct" && current.kind === "lan") {
        // WebRTC already found a same-network pair; the socket would be the same path again.
        scheduleLan(60_000);
        return;
      }
      const net = await phoneNetwork(credential.lanAddresses, attempt.signal);
      // A private address is unreachable with no network, and on cellular without a VPN that
      // could route it. Not rescheduled: only a network change helps, and that rebuilds the session.
      const skip =
        net?.kind === "none"
          ? "no_network"
          : net?.kind === "cellular" && !net.vpn
            ? "cellular"
            : "";
      if (skip) {
        reportLinkEvent("lan_upgrade", { result: "skipped", reason: skip });
        return;
      }
      lanFar = net?.kind === "cellular" || net?.kind === "other_subnet";
      const next = await connectLan(
        {
          ...options,
          discover: async () => () => {},
          discoverEnabled: false,
          allowDirect: false,
          createRtcPeer: options.createRtcPeer ?? createMobileRtcPeer,
        },
        credential,
        AbortSignal.any([signal, attempt.signal]),
        4_000,
        credential.lanAddresses,
      );
      if (attempt.signal.aborted || ended()) return void (await next.close());
      next.path = "lan";
      selected = next;
      lanRetries = 0;
      reportLinkEvent("lan_upgrade", { result: "connected" });
      for (const listener of upgradeListeners) await listener(next);
      next.onClose?.(() => {
        if (selected !== next || ended()) return;
        selected = relay;
        reportLinkEvent("lan_upgrade", { result: "fallback" });
        // The relay session may have changed path since the first snapshot; rebind to its current one.
        for (const listener of upgradeListeners) void listener(snapshot());
        scheduleLan(5_000);
      });
      // Keep the relay alive as the authenticated fallback; PathSession still owns its
      // signaling and will close it with the generation.
    } catch {
      if (ended() || attempt.signal.aborted) return;
      reportLinkEvent("lan_upgrade", { result: "unavailable" });
      if (selected === relay)
        scheduleLan(
          (lanFar ? [30_000, 120_000] : [5_000, 30_000])[lanRetries++] ??
            (lanFar ? 300_000 : 60_000),
        );
    } finally {
      if (lanAttempt === attempt) lanAttempt = undefined;
    }
  };
  // A desktop that quit keeps this session on the relay while its direct retries back off to
  // minutes; when it says it is available again the next attempt goes at once.
  let desktopQuit = false;
  const onInteractive = (state: "available" | "quit") => {
    if (state === "quit") desktopQuit = true;
    else if (desktopQuit) {
      desktopQuit = false;
      if (allowDirect) session.retryDirectNow();
    }
  };
  const snapshot = () => {
    const path = session.current();
    return portConnection({
      port: path.port,
      path: path.path,
      ...(path.kind ? { pathKind: path.kind } : {}),
      closed: path.closed,
      epoch,
      onDirectSettings: (settings) => {
        stunUrl = settings.mode === "stun" ? settings.stunUrl : undefined;
      },
      onKeepalive: () => session.enableKeepalive(),
      onInteractive,
      close: (reason) => session.close(reason),
    });
  };
  const relay = snapshot();
  selected = relay;
  void tryLanUpgrade();
  return {
    ...relay,
    onClose(listener: () => void) {
      const abort = () => listener();
      session.closed.addEventListener("abort", abort, { once: true });
      if (session.closed.aborted) abort();
      return () => session.closed.removeEventListener("abort", abort);
    },
    onPath: (listener: (connection: LinkConnection) => Promise<void>) => {
      upgradeListeners.add(listener);
      // While the LAN link is selected, the relay session's own path changes are not the route.
      const off = session.onChange(async () => {
        if (selected === relay) await listener(snapshot());
      });
      if (selected && selected !== relay) void listener(selected);
      return () => {
        upgradeListeners.delete(listener);
        off();
      };
    },
    onDirectFailure: (listener) => session.onDirectFailure(listener),
    refreshLan: () => {
      if (ended() || selected !== relay || lanAttempt) return;
      clearTimeout(lanRetry);
      lanRetry = undefined;
      lanRetries = 0;
      void tryLanUpgrade();
    },
    networkChanged: async () => {
      lanAttempt?.abort();
      clearTimeout(lanRetry);
      lanRetry = undefined;
      if (selected === relay) void tryLanUpgrade();
      await session.networkChanged();
    },
    pulse: () => session.pulse(),
    setExternalClock: (active: boolean) => session.setExternalClock(active),
    probe: (timeoutMs: number) => session.probe(timeoutMs),
    endReason: () => session.endReason(),
    directBroken: () => session.broken(),
    close: async (reason) => {
      lanAttempt?.abort();
      clearTimeout(lanRetry);
      await Promise.allSettled([
        session.close(reason),
        selected && selected !== relay ? selected.close(reason) : Promise.resolve(),
      ]);
    },
  } satisfies LinkConnection;
}

export function createMobileLink(options: Options): MobileLink {
  // A failed transport cleanup cannot quarantine unrelated future authenticated generations.
  let pairing = false;
  return {
    async pair(qr, name, signal) {
      if (pairing) throw new Error("busy");
      pairing = true;
      try {
        const paired = await pairChannel(options.WebSocket, options.random, qr, name, signal);
        // T3 only assigns desktopId through devices.self after committing the phone identity.
        // The computer joins the new room only after it committed the pair, often seconds later.
        const wire = await relayWire(options, paired.credential, signal, 20_000, 20_000);
        const connection = portConnection({
          port: wire.port,
          closed: wire.closed,
          close: wire.close,
        });
        try {
          const self = await connection.self(signal);
          signal.throwIfAborted();
          const computer: Computer = {
            id: self.id,
            name: self.name,
            relay: paired.credential.relay,
            publicKey: paired.credential.publicKey,
            safetyCode: paired.safetyCode,
          };
          return { computer, credential: JSON.stringify(paired.credential) };
        } finally {
          await connection.close();
        }
      } catch (error) {
        reportLinkFailure(error, "link");
        throw error;
      } finally {
        pairing = false;
      }
    },
    async connect(computer, raw, signal, timeoutMs, connectOptions) {
      const credential = readCredential(raw);
      if (credential.publicKey !== computer.publicKey || credential.relay !== computer.relay)
        throw new Error("credential_identity_changed");
      const discover = options.discoverLan;
      return firstConnection<LinkConnection>(
        [
          ...(discover || credential.lanAddresses.length
            ? [
                (active: AbortSignal) =>
                  connectLan(
                    {
                      ...options,
                      discover: discover ?? (async () => () => {}),
                      discoverEnabled: !!discover,
                      createRtcPeer: options.createRtcPeer ?? createMobileRtcPeer,
                    },
                    credential,
                    active,
                    timeoutMs,
                    credential.lanAddresses,
                  ),
              ]
            : []),
          async (active) => {
            if (credential.lanAddresses.length) await waitForLanWindow(active);
            return connect(
              options,
              credential,
              active,
              timeoutMs,
              connectOptions?.waitForComputerMs,
              connectOptions?.direct !== false,
            );
          },
        ],
        signal,
      );
    },
  };
}
