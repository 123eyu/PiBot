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
  type RandomBytes,
  type SocketConstructor,
  safetyCode,
  sharedSecret,
  unbase64,
} from "@pibot/link";
import { z } from "zod";
import type { Credential } from "./credential.ts";
import { openPhoneRoom } from "./relay-room.ts";

/** Match the desktop's encrypted identity/rotation exchange; no business Peer during pairing. */
export async function pairChannel(
  WebSocket: SocketConstructor,
  random: RandomBytes,
  qr: string,
  name: string,
  signal: AbortSignal,
) {
  const payload = decodePairing(qr);
  const keys = createEndpoint(random);
  let room: Awaited<ReturnType<typeof openPhoneRoom>> | undefined;
  let port: ReturnType<typeof encryptedPort> | undefined;
  let off = () => {};
  let offAbort = () => {};
  let shared: Uint8Array | undefined;
  let rotation: Uint8Array | undefined;
  let roomKey: Uint8Array | undefined;
  try {
    room = await openPhoneRoom(
      WebSocket,
      payload.relay,
      pairingRoom(payload),
      signal,
      20_000,
      20_000,
    );
    const active = AbortSignal.any([signal, room.signal, AbortSignal.timeout(20_000)]);
    const channel = await establishNoise(room.transport, {
      role: "initiator",
      staticSecret: keys.dhSecret,
      remoteStatic: dhPublic(payload.publicKey),
      random,
      psk: payload.psk,
      prologue: pairingPrologue(payload),
      signal: active,
    });
    port = encryptedPort(channel, room.transport, { signal: active });
    const response = await new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        off();
        reject(new Error("pair_cancelled"));
      };
      const receive = port as ReturnType<typeof encryptedPort>;
      off = receive.onMessage((value) => {
        off();
        active.removeEventListener("abort", abort);
        resolve(value);
      });
      active.addEventListener("abort", abort, { once: true });
      offAbort = () => active.removeEventListener("abort", abort);
      if (active.aborted) abort();
      else {
        try {
          receive.post(identityProof(keys, channel, name));
        } catch {
          abort();
        }
      }
    });
    const envelope = z
      .strictObject({ identity: z.unknown(), rotation: z.string().max(64) })
      .parse(response);
    acceptIdentity(envelope.identity, channel, payload.publicKey);
    rotation = unbase64(envelope.rotation, 32);
    shared = sharedSecret(keys, payload.publicKey);
    roomKey = deriveRoomKey(shared, rotation);
    active.throwIfAborted();
    if (Date.now() >= payload.expiresAt) throw new Error("pair_expired");
    port.post({ paired: true });
    const credential: Credential = {
      version: 1,
      seed: base64url(keys.secret),
      roomKey: base64url(roomKey),
      publicKey: base64url(payload.publicKey),
      relay: payload.relay,
      lanAddresses: [],
    };
    return { credential, safetyCode: safetyCode(keys.signingPublic, payload.publicKey) };
  } finally {
    off();
    offAbort();
    port?.dispose?.();
    destroyEndpoint(keys);
    payload.psk.fill(0);
    shared?.fill(0);
    rotation?.fill(0);
    roomKey?.fill(0);
    await room?.close();
  }
}
