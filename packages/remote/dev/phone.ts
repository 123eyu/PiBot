import { randomBytes } from "node:crypto";
import {
  acceptIdentity,
  base64url,
  createEndpoint,
  decodePairing,
  deriveRoomKey,
  destroyEndpoint,
  dhPublic,
  encryptedPort,
  establishNoise,
  identityProof,
  pairingPrologue,
  pairingRoom,
  roomTicket,
  sharedSecret,
  unbase64,
} from "@pibot/link";
import { openPushRoute } from "@pibot/link/room";
import { createPeer, Events, Methods } from "@pibot/protocol";
import { z } from "zod";
import { nextMessage } from "../src/brain/link/adapter.ts";
import { type LinkNetwork, openRoom } from "../src/brain/link/socket.ts";

/** A real link endpoint; only its relay URL transport mapping is local to the exercise. */
export async function pairPhone(payload: string, network: LinkNetwork, signal: AbortSignal) {
  const qr = decodePairing(payload);
  const identity = createEndpoint(randomBytes);
  const room = await openRoom(network, qr.relay, pairingRoom(qr), "phone", signal);
  try {
    await room.waitPresence();
    const channel = await establishNoise(room.transport, {
      role: "initiator",
      staticSecret: identity.dhSecret,
      remoteStatic: dhPublic(qr.publicKey),
      psk: qr.psk,
      prologue: pairingPrologue(qr),
      random: randomBytes,
      signal,
    });
    const port = encryptedPort(channel, room.transport, { signal });
    const result = nextMessage(port, signal);
    port.post(identityProof(identity, channel, "Node phone"));
    const response = z
      .strictObject({ identity: z.unknown(), rotation: z.string() })
      .parse(await result);
    acceptIdentity(response.identity, channel, qr.publicKey);
    const shared = sharedSecret(identity, qr.publicKey);
    const key = deriveRoomKey(shared, unbase64(response.rotation, 32));
    shared.fill(0);
    port.post({ paired: true });
    // Wait for the desktop's resource owner to acknowledge closure before leaving pairing.
    await new Promise<void>((resolve) => {
      if (room.signal.aborted) resolve();
      else room.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    port.dispose?.();
    return {
      publicKey: base64url(identity.signingPublic),
      openRoute(value: string) {
        return openPushRoute(key, value);
      },
      async connect(connectionSignal: AbortSignal) {
        const current = await openRoom(
          network,
          qr.relay,
          roomTicket(key),
          "phone",
          connectionSignal,
        );
        try {
          await current.waitPresence();
          const channel = await establishNoise(current.transport, {
            role: "initiator",
            staticSecret: identity.dhSecret,
            remoteStatic: dhPublic(qr.publicKey),
            random: randomBytes,
            signal: AbortSignal.any([connectionSignal, current.signal]),
          });
          const port = encryptedPort(channel, current.transport, { signal: current.signal });
          const peer = createPeer(port, { methods: Methods, events: Events });
          return {
            peer,
            port,
            signal: current.signal,
            async close() {
              peer.dispose();
              await current.close();
            },
          };
        } catch (error) {
          await current.close();
          throw error;
        }
      },
      dispose() {
        key.fill(0);
        destroyEndpoint(identity);
        qr.psk.fill(0);
      },
    };
  } catch (error) {
    destroyEndpoint(identity);
    throw error;
  } finally {
    await room.close();
  }
}
