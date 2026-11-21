import { randomBytes } from "node:crypto";
import type { SocketLike } from "@pibot/link";
import {
  type DirectDiagnosticSink,
  destroyEndpoint,
  dhPublic,
  encryptedPort,
  endpointKeys,
  establishDirectNoise,
  establishNoise,
  negotiateDirect,
  type RtcPeerFactory,
  unbase64,
} from "@pibot/link";
import { LAN_PROLOGUE, lanPathSession, signalingWire } from "@pibot/link/lan";
import { lanSocket } from "@pibot/link/lan-socket";
import { desktopNetworkHint } from "../link/network-hint.ts";
import type { LinkSession, RemoteLinkPort } from "../link/port.ts";

export type LanConnect = Parameters<RemoteLinkPort["connect"]>[0];
export async function acceptLanSession(
  socket: SocketLike,
  input: LanConnect,
  createPeer: RtcPeerFactory,
  signal: AbortSignal,
  onDirectDiagnostic?: DirectDiagnosticSink,
): Promise<LinkSession> {
  const wire = lanSocket(socket, signal);
  const seed = unbase64(input.identity.privateKey, 32);
  const keys = endpointKeys(seed);
  seed.fill(0);
  try {
    const channel = await establishNoise(wire.transport, {
      role: "responder",
      staticSecret: keys.dhSecret,
      remoteStatic: dhPublic(unbase64(input.publicKey, 32)),
      random: randomBytes,
      prologue: LAN_PROLOGUE,
      signal,
      timeoutMs: 5000,
    });
    const port = encryptedPort(channel, wire.transport, { signal });
    const session = await lanPathSession({
      onDiagnostic: onDirectDiagnostic,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      relay: signalingWire({
        port,
        closed: wire.transport.closed,
        close: async () => {
          port.dispose?.();
          await wire.close();
        },
      }),
      signal,
      role: "responder",
      reconnect: async () => {
        throw new Error("lan_signaling_closed");
      },
      async direct(port, active) {
        const data = await negotiateDirect({
          failureHint: desktopNetworkHint,
          port,
          createPeer,
          role: "responder",
          signal: active,
          onDiagnostic: onDirectDiagnostic,
        });
        const seed = unbase64(input.identity.privateKey, 32);
        const identity = endpointKeys(seed);
        seed.fill(0);
        try {
          const { channel, transport } = await establishDirectNoise(data, {
            role: "responder",
            staticSecret: identity.dhSecret,
            remoteStatic: dhPublic(unbase64(input.publicKey, 32)),
            random: randomBytes,
            signal: active,
          });
          const encrypted = encryptedPort(channel, transport, { signal: active });
          return {
            port: encrypted,
            closed: transport.closed,
            close: async () => {
              encrypted.dispose?.();
            },
          };
        } finally {
          destroyEndpoint(identity);
        }
      },
    });
    return {
      get port() {
        return session.current().port;
      },
      signal: session.closed,
      keepalive: true,
      endReason: () => session.endReason(),
      currentPath: () => session.current(),
      onPath: (fn) => session.onChange(fn),
      onDirectFailure: (fn) => session.onDirectFailure(fn),
      onPresence(fn) {
        fn(!session.closed.aborted);
        const stop = () => fn(false);
        session.closed.addEventListener("abort", stop, { once: true });
        return () => session.closed.removeEventListener("abort", stop);
      },
      close: (reason) => session.close(reason),
    };
  } catch (error) {
    await wire.close();
    throw error;
  } finally {
    destroyEndpoint(keys);
  }
}
