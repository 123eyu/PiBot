import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  base64url,
  concat,
  equal,
  LinkError,
  requireBytes,
  unbase64,
  utf8,
} from "../core/bytes.ts";
export const ROOM_PERIOD_MS = 86_400_000;
export interface RoomTicket {
  roomId: string;
  credential: string;
  period: number;
}
export function roomPeriod(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new LinkError("invalid_period");
  return Math.floor(now / ROOM_PERIOD_MS);
}
// Both endpoints retain the rotation salt; replacing it retires this phone's room key.
export function deriveRoomKey(shared: Uint8Array, rotation: Uint8Array) {
  return hkdf(
    sha256,
    requireBytes(shared, 32),
    requireBytes(rotation, 32),
    utf8("pibot-room-key-v1"),
    32,
  );
}
export function roomTicket(key: Uint8Array, period = roomPeriod()): RoomTicket {
  if (!Number.isSafeInteger(period) || period < 0) throw new LinkError("invalid_period");
  const credential = hmac(sha256, requireBytes(key, 32), utf8(`pibot-room-access-v1:${period}`));
  return {
    roomId: base64url(sha256(concat(utf8(`pibot-room-v1:${period}:`), credential))),
    credential: base64url(credential),
    period,
  };
}
// The room ID commits to the opaque credential without exposing a shared room key to the relay.
export function validateRoomTicket(value: unknown, now = Date.now()): RoomTicket {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LinkError("invalid_room_ticket");
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).sort().join(",") !== "credential,period,roomId" ||
    typeof p.roomId !== "string" ||
    typeof p.credential !== "string" ||
    typeof p.period !== "number"
  )
    throw new LinkError("invalid_room_ticket");
  if (
    p.period !== roomPeriod(now) ||
    !equal(
      unbase64(p.roomId, 32),
      sha256(
        concat(utf8(`pibot-room-v1:${p.period}:`), requireBytes(unbase64(p.credential, 32), 32)),
      ),
    )
  )
    throw new LinkError("invalid_room_ticket");
  return { roomId: p.roomId, credential: p.credential, period: p.period };
}
export function credentialMatches(actual: string, expected: string) {
  try {
    return equal(requireBytes(unbase64(actual, 32), 32), requireBytes(unbase64(expected, 32), 32));
  } catch {
    return false;
  }
}
export function rateKey(ip: string) {
  return base64url(sha256(utf8(`pibot-ip-v1:${ip}`)));
}
