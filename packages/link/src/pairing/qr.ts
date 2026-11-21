import { sha256 } from "@noble/hashes/sha2.js";
import {
  base64url,
  concat,
  equal,
  LinkError,
  type RandomBytes,
  readSequence,
  requireBytes,
  sequence,
  text,
  unbase64,
  utf8,
} from "../core/bytes.ts";
import { dhPublic } from "../keys/endpoint.ts";
export interface PairingPayload {
  version: 1;
  relay: string;
  publicKey: Uint8Array;
  psk: Uint8Array;
  name: string;
  expiresAt: number;
}
export function relayAddress(value: string, local = false) {
  if (value.length > 1024 || !/^wss:\/\/[a-z0-9.[\]:-]+(?:\/[a-z0-9_./~-]*)?$/i.test(value)) {
    if (!local || !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(value))
      throw new LinkError("invalid_relay");
  }
  return value.replace(/\/$/, "");
}
export function deviceName(value: string) {
  if (
    !value.trim() ||
    utf8(value).length > 200 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new LinkError("invalid_device_name");
  return value;
}
export function createPairingPayload(
  relay: string,
  publicKey: Uint8Array,
  name: string,
  random: RandomBytes,
  now = Date.now(),
): PairingPayload {
  return {
    version: 1,
    relay: relayAddress(relay),
    publicKey: requireBytes(publicKey, 32).slice(),
    psk: requireBytes(random(32), 32).slice(),
    name: deviceName(name),
    expiresAt: now + 600_000,
  };
}
export function encodePairing(payload: PairingPayload) {
  relayAddress(payload.relay);
  deviceName(payload.name);
  dhPublic(payload.publicKey);
  if (payload.version !== 1 || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= 0)
    throw new LinkError("invalid_pairing");
  const relay = utf8(payload.relay),
    name = utf8(payload.name);
  const lengths = Uint8Array.of(
    relay.length >> 8,
    relay.length & 255,
    name.length >> 8,
    name.length & 255,
  );
  const bytes = concat(
    Uint8Array.of(1),
    sequence(BigInt(payload.expiresAt)),
    requireBytes(payload.publicKey, 32),
    requireBytes(payload.psk, 32),
    lengths,
    relay,
    name,
  );
  return `pibot-pair:${base64url(concat(bytes, sha256(bytes).subarray(0, 8)))}`;
}
export function decodePairing(qr: string, now = Date.now()): PairingPayload {
  if (!qr.startsWith("pibot-pair:")) throw new LinkError("invalid_pairing");
  const bytes = unbase64(qr.slice(11), 1500),
    body = bytes.subarray(0, -8);
  if (bytes.length < 85 || body[0] !== 1 || !equal(sha256(body).subarray(0, 8), bytes.subarray(-8)))
    throw new LinkError("invalid_pairing");
  const relayLength = ((body[73] as number) << 8) | (body[74] as number),
    nameLength = ((body[75] as number) << 8) | (body[76] as number);
  if (77 + relayLength + nameLength !== body.length) throw new LinkError("invalid_pairing");
  const expiresAt = Number(readSequence(body.subarray(1, 9)));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 600_000)
    throw new LinkError("pairing_expired");
  const publicKey = body.slice(9, 41);
  dhPublic(publicKey);
  return {
    version: 1,
    expiresAt,
    publicKey,
    psk: body.slice(41, 73),
    relay: relayAddress(text(body.subarray(77, 77 + relayLength))),
    name: deviceName(text(body.subarray(77 + relayLength))),
  };
}
