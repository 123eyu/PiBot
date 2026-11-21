import { sha256 } from "@noble/hashes/sha2.js";
import { LinkError, utf8 } from "../core/bytes.ts";
import { deriveRoomKey, roomPeriod, roomTicket } from "../room/index.ts";
import { encodePairing, type PairingPayload } from "./qr.ts";
export function pairingRoom(payload: PairingPayload, now = Date.now()) {
  if (payload.expiresAt <= now || payload.expiresAt > now + 600_000)
    throw new LinkError("pairing_expired");
  const key = deriveRoomKey(payload.psk, sha256(payload.publicKey));
  try {
    return roomTicket(key, roomPeriod(now));
  } finally {
    key.fill(0);
  }
}
export function pairingPrologue(payload: PairingPayload) {
  return sha256(utf8(encodePairing(payload)));
}
