import { randomBytes } from "node:crypto";
import {
  acceptIdentity,
  base64url,
  connectRunnerPunch,
  createEndpoint,
  createPairingPayload,
  type DirectDiagnosticSink,
  deriveRoomKey,
  destroyEndpoint,
  dhPublic,
  encodePairing,
  encryptedPort,
  endpointKeys,
  establishDirectNoise,
  establishNoise,
  identityProof,
  negotiateDirect,
  PathSession,
  pairingLease,
  pairingPrologue,
  pairingRoom,
  ROOM_PERIOD_MS,
  type RtcPeerFactory,
  roomTicket,
  safetyCode,
  sharedSecret,
  unbase64,
} from "@pibot/link";
import { sealPushRoute } from "@pibot/link/room";
import type { Port } from "@pibot/protocol-base";
import { z } from "zod";
import { desktopNetworkHint } from "./network-hint.ts";
import type { EndpointIdentity, RemoteLinkPort } from "./port.ts";
import { connectPairedRunner, pairRunner } from "./runner.ts";
import { type LinkNetwork, openRoom } from "./socket.ts";

const RoomSecret = z.strictObject({ key: z.string(), publicKey: z.string(), rotation: z.string() });
const keys = (identity: EndpointIdentity) => {
  const value = endpointKeys(unbase64(identity.privateKey, 32));
  if (base64url(value.signingPublic) !== identity.publicKey) {
    destroyEndpoint(value);
    throw new Error("remote_identity_mismatch");
  }
  return value;
};
const secret = (value: string) => {
  const parsed = RoomSecret.parse(JSON.parse(value));
  return { ...parsed, bytes: unbase64(parsed.key, 32) };
};
/** Pairing metadata uses the same authenticated channel, before any business Peer exists. */
export function nextMessage(port: Port, signal: AbortSignal): Promise<unknown> {
  const pending = new Promise((resolve, reject) => {
    const abort = () => {
      off();
      signal.removeEventListener("abort", abort);
      reject(new Error("remote_exchange_cancelled"));
    };
    const off = port.onMessage((value) => {
      off();
      signal.removeEventListener("abort", abort);
      resolve(value);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  // A send may fail before the caller awaits its reply; cancellation must still be observed.
  void pending.catch(() => {});
  return pending;
}
export function createRemoteLink(
  network: LinkNetwork & {
    officialRelayUrl?: string;
    createRtcPeer?: RtcPeerFactory;
    onDirectDiagnostic?: DirectDiagnosticSink;
  } = {},
): RemoteLinkPort {
  const revoked = new Set<string>();
  const relayLink: RemoteLinkPort = {
    kind: "link",
    officialRelayUrl: network.officialRelayUrl,
    pairRunner: (input) => pairRunner(network, input),
    async createIdentity(signal) {
      signal.throwIfAborted();
      const value = createEndpoint(randomBytes);
      try {
        return { publicKey: base64url(value.signingPublic), privateKey: base64url(value.secret) };
      } finally {
        destroyEndpoint(value);
      }
    },
    async pair(input) {
      const identity = keys(input.identity);
      const payload = createPairingPayload(
        input.relayUrl,
        identity.signingPublic,
        input.name,
        randomBytes,
      );
      payload.expiresAt = Math.min(payload.expiresAt, Date.parse(input.expiresAt));
      const encoded = encodePairing(payload);
      const lease = pairingLease(payload.psk, payload.expiresAt);
      const lifetime = new AbortController();
      const signal = AbortSignal.any([
        input.signal,
        lifetime.signal,
        AbortSignal.timeout(Math.max(1, payload.expiresAt - Date.now())),
      ]);
      let room: Awaited<ReturnType<typeof openRoom>>;
      try {
        // No lifecycle retries a pairing room: keep reopening until the pairing setup deadline.
        room = await openRoom(
          network,
          input.relayUrl,
          pairingRoom(payload),
          "desktop",
          signal,
          undefined,
          {
            retryUntilOpen: true,
          },
        );
      } catch (error) {
        lease.dispose();
        destroyEndpoint(identity);
        throw error;
      }
      const completed = (async () => {
        let port: Port | undefined;
        const connected = AbortSignal.any([signal, room.signal]);
        try {
          // The responder is installed immediately; presence alone does not authenticate a phone.
          const channel = await establishNoise(room.transport, {
            role: "responder",
            staticSecret: identity.dhSecret,
            psk: lease.claim(),
            random: randomBytes,
            prologue: pairingPrologue(payload),
            signal: connected,
            timeoutMs: Math.max(1, payload.expiresAt - Date.now()),
          });
          const exchange = AbortSignal.any([connected, AbortSignal.timeout(10_000)]);
          port = encryptedPort(channel, room.transport, { signal: connected });
          const phone = acceptIdentity(await nextMessage(port, exchange), channel);
          const rotation = randomBytes(32);
          const shared = sharedSecret(identity, phone.publicKey);
          const key = deriveRoomKey(shared, rotation);
          shared.fill(0);
          try {
            const confirmation = nextMessage(port, exchange);
            port.post({
              identity: identityProof(identity, channel, input.name),
              rotation: base64url(rotation),
            });
            const ack = z.strictObject({ paired: z.literal(true) }).parse(await confirmation);
            if (!ack.paired) throw new Error("remote_pair_unconfirmed");
            signal.throwIfAborted();
            lease.commit();
            return {
              publicKey: base64url(phone.publicKey),
              name: phone.name,
              room: base64url(rotation),
              roomSecret: JSON.stringify({
                key: base64url(key),
                rotation: base64url(rotation),
                publicKey: base64url(phone.publicKey),
              }),
              securityCode: safetyCode(identity.signingPublic, phone.publicKey),
            };
          } finally {
            key.fill(0);
            rotation.fill(0);
          }
        } finally {
          port?.dispose?.();
          lease.dispose();
          destroyEndpoint(identity);
          await room.close();
        }
      })();
      void completed.catch(() => {});
      return {
        payload: encoded,
        completed,
        async close() {
          lifetime.abort();
          await room.close();
          await completed.catch(() => {});
        },
      };
    },
    async connect(input) {
      if (revoked.has(input.room)) throw new Error("remote_device_revoked");
      if (input.kind === "runner") return connectPairedRunner(network, input);
      const identity = keys(input.identity);
      const value = secret(input.roomSecret);
      if (value.publicKey !== input.publicKey || value.rotation !== input.room) {
        destroyEndpoint(identity);
        value.bytes.fill(0);
        throw new Error("remote_room_mismatch");
      }
      const lifetime = new AbortController();
      let room: Awaited<ReturnType<typeof openRoom>> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unwatch: (() => void) | undefined;
      try {
        room = await openRoom(
          network,
          input.relayUrl,
          roomTicket(value.bytes),
          "desktop",
          AbortSignal.any([input.signal, lifetime.signal]),
          input.onPhase,
          // Below mobile carrier NAT idle timeouts on the desktop's own uplink too.
          { heartbeatMs: 20_000 },
        );
        // Wait in the room for as long as it takes the phone to show up; only the handshake itself
        // is bounded. A 20 s wait plus growing backoff on both ends made the two sides miss
        // each other for minutes even though both were online.
        // The room ID is per UTC day: stop waiting at the boundary and rejoin the new room.
        timer = setTimeout(
          () => lifetime.abort(),
          ROOM_PERIOD_MS - (Date.now() % ROOM_PERIOD_MS) + 20,
        );
        await room.waitPresence();
        const current = room;
        let ended: string | undefined;
        const end = (reason: string) => {
          ended ??= reason;
          lifetime.abort();
        };
        clearTimeout(timer);
        const signal = AbortSignal.any([
          input.signal,
          lifetime.signal,
          AbortSignal.timeout(20_000),
        ]);
        timer = setTimeout(() => lifetime.abort(), 20_000);
        input.onPhase?.("handshake");
        const channel = await establishNoise(room.transport, {
          role: "responder",
          staticSecret: identity.dhSecret,
          remoteStatic: dhPublic(unbase64(input.publicKey, 32)),
          random: randomBytes,
          signal,
        });
        clearTimeout(timer);
        if (revoked.has(input.room)) {
          channel.dispose();
          throw new Error("remote_device_revoked");
        }
        const port = encryptedPort(channel, room.transport, { signal: room.signal });
        // The phone's next visit starts a fresh handshake; drop this session as soon as it leaves
        // so the desktop is back to waiting instead of holding a stale channel.
        unwatch = room.watchPresence((online) => {
          if (!online) end("peer_left");
        });
        timer = setTimeout(
          () => end("room_rotated"),
          ROOM_PERIOD_MS - (Date.now() % ROOM_PERIOD_MS) + 20,
        );
        return {
          port,
          signal: room.signal,
          endReason: () => ended ?? current.reason(),
          onPresence(fn) {
            fn(!room?.signal.aborted);
            const off = () => fn(false);
            room?.signal.addEventListener("abort", off, { once: true });
            return () => room?.signal.removeEventListener("abort", off);
          },
          async close() {
            clearTimeout(timer);
            unwatch?.();
            ended ??= "local_close";
            lifetime.abort();
            port.dispose?.();
            await room?.close();
          },
        };
      } catch (error) {
        clearTimeout(timer);
        unwatch?.();
        lifetime.abort();
        await room?.close();
        throw error;
      } finally {
        destroyEndpoint(identity);
        value.bytes.fill(0);
      }
    },
    async revoke(input) {
      input.signal.throwIfAborted();
      const value = secret(input.roomSecret);
      // Revoked devices are removed durably before this call; no server-side revoke list exists.
      // A fresh rotation destroys the old local room key. Never rejoin the old room after this.
      const rotated = deriveRoomKey(value.bytes, randomBytes(32));
      rotated.fill(0);
      value.bytes.fill(0);
      revoked.add(input.room);
    },
    async push(input) {
      const value = secret(input.roomSecret);
      try {
        if (revoked.has(input.room)) throw new Error("remote_device_revoked");
        const response = await (network.fetch ?? globalThis.fetch)(
          `${input.relayUrl.replace(/^wss:/, "https:")}/push`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              room: roomTicket(value.bytes),
              expoToken: input.token,
              kind: input.kind,
              route: sealPushRoute(value.bytes, JSON.stringify(input.route), randomBytes),
            }),
          },
        );
        await response.body?.cancel();
        // 410: the relay heard DeviceNotRegistered from Expo; the caller clears the token.
        if (response.status === 410) throw new Error("remote_push_unregistered");
        if (!response.ok) throw new Error("remote_push_failed");
      } finally {
        value.bytes.fill(0);
      }
    },
  };
  const createPeer = network.createRtcPeer;
  /**
   * Phone sessions run on a PathSession even without WebRTC (a server brain): it owns the relay
   * reconnect, the end-to-end keepalive and the close reasons. Direct upgrades need the RTC host.
   */
  const connectPhone: RemoteLinkPort["connect"] = async (input) => {
    const open = async (signal: AbortSignal) => {
      const session = await relayLink.connect({ ...input, signal });
      return {
        port: session.port,
        closed: session.signal as AbortSignal,
        close: () => session.close(),
        reason: () => session.endReason?.(),
      };
    };
    const relay = await open(input.signal);
    const session = new PathSession({
      onDiagnostic: network.onDirectDiagnostic,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      relay,
      reconnect: open,
      role: "responder",
      signal: input.signal,
      ...(createPeer
        ? {
            async direct(port: Port, signal: AbortSignal) {
              // Diagnostics only: the last bad ICE state names why an open direct path ended.
              let ice: string | undefined;
              const data = await negotiateDirect({
                failureHint: desktopNetworkHint,
                onDiagnostic: (event) => {
                  if (
                    (event.event === "ice" || event.event === "connection") &&
                    event.state !== "closed"
                  )
                    ice =
                      event.state === "failed" || event.state === "disconnected"
                        ? event.state
                        : undefined;
                  network.onDirectDiagnostic?.(event);
                },
                port,
                createPeer: (options) => createPeer({ ...options, stunUrl: input.stunUrl }),
                role: "responder",
                signal,
              });
              const identity = keys(input.identity);
              try {
                const { transport, channel } = await establishDirectNoise(data, {
                  role: "responder",
                  staticSecret: identity.dhSecret,
                  remoteStatic: dhPublic(unbase64(input.publicKey, 32)),
                  random: randomBytes,
                  signal,
                });
                const encrypted = encryptedPort(channel, transport, { signal });
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
                destroyEndpoint(identity);
              }
            },
          }
        : {}),
    });
    return {
      get port() {
        return session.current().port;
      },
      signal: session.closed,
      keepalive: true,
      endReason: () => session.endReason(),
      currentPath: () => session.current(),
      onPath: (listener) => session.onChange(listener),
      onDirectFailure: (listener) => session.onDirectFailure(listener),
      onPresence(listener) {
        listener(!session.closed.aborted);
        const off = () => listener(false);
        session.closed.addEventListener("abort", off, { once: true });
        return () => session.closed.removeEventListener("abort", off);
      },
      close: (reason) => session.close(reason),
    };
  };
  const link: RemoteLinkPort = {
    ...relayLink,
    connect: (input) => (input.kind === "runner" ? relayLink.connect(input) : connectPhone(input)),
  };
  if (!createPeer) return link;
  return {
    ...link,
    async connectRunnerPunch(input) {
      const identity = keys(input.identity);
      const id = randomBytes(16).toString("hex");
      const stop = new AbortController();
      let pending: ReturnType<typeof connectRunnerPunch> | undefined;
      try {
        pending = connectRunnerPunch({
          ...input,
          id,
          signal: AbortSignal.any([input.signal, stop.signal]),
          keys: identity,
          role: "responder",
          random: randomBytes,
          createPeer,
          onDiagnostic: network.onDirectDiagnostic,
        });
        void pending.catch(() => {});
        input.port.post({
          jsonrpc: "2.0",
          method: "link.runner.punch",
          params: { id, stunUrl: input.stunUrl },
        });
        const session = await pending;
        return {
          ...session,
          runnerPath: "punched" as const,
          onPresence(listener) {
            listener(!session.signal.aborted);
            const closed = () => listener(false);
            session.signal.addEventListener("abort", closed, { once: true });
            return () => session.signal.removeEventListener("abort", closed);
          },
        };
      } catch (error) {
        stop.abort();
        if (pending) await Promise.allSettled([pending]);
        throw error;
      } finally {
        destroyEndpoint(identity);
      }
    },
  };
}
