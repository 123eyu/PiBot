import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  base64url,
  concat,
  EMPTY,
  LinkError,
  type RandomBytes,
  requireBytes,
  text,
  unbase64,
  utf8,
} from "../core/bytes.ts";
import { type RoomTicket, validateRoomTicket } from "./ticket.ts";
export interface PushRequest {
  room: RoomTicket;
  expoToken: string;
  kind: "approval" | "run_done" | "run_failed" | "wake";
  route: string;
}
const associated = utf8("pibot-push-route-v1");
export function sealPushRoute(key: Uint8Array, routeId: string, random: RandomBytes) {
  const bytes = utf8(routeId);
  if (bytes.length < 1 || bytes.length > 512) throw new LinkError("invalid_push_route");
  const derived = hkdf(sha256, requireBytes(key, 32), EMPTY, associated, 32),
    nonce = requireBytes(random(12), 12);
  try {
    return base64url(concat(nonce, chacha20poly1305(derived, nonce, associated).encrypt(bytes)));
  } finally {
    derived.fill(0);
  }
}
export function openPushRoute(key: Uint8Array, route: string) {
  const frame = unbase64(route, 540);
  if (frame.length < 29) throw new LinkError("invalid_push_route");
  const derived = hkdf(sha256, requireBytes(key, 32), EMPTY, associated, 32);
  try {
    return text(
      chacha20poly1305(derived, frame.subarray(0, 12), associated).decrypt(frame.subarray(12)),
    );
  } catch {
    throw new LinkError("invalid_push_route");
  } finally {
    derived.fill(0);
  }
}
export function parsePushRequest(value: unknown, now = Date.now()): PushRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LinkError("invalid_push");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "expoToken,kind,room,route" ||
    typeof v.expoToken !== "string" ||
    !/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/.test(v.expoToken) ||
    !(
      v.kind === "approval" ||
      v.kind === "run_done" ||
      v.kind === "run_failed" ||
      v.kind === "wake"
    ) ||
    typeof v.route !== "string"
  )
    throw new LinkError("invalid_push");
  const bytes = unbase64(v.route, 540);
  if (bytes.length < 29) throw new LinkError("invalid_push");
  return {
    room: validateRoomTicket(v.room, now),
    expoToken: v.expoToken,
    kind: v.kind,
    route: v.route,
  };
}
