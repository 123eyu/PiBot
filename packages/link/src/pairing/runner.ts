import { sha256 } from "@noble/hashes/sha2.js";
import { LinkError, type RandomBytes, utf8 } from "../core/bytes.ts";
import { roomTicket } from "../room/ticket.ts";
import { relayAddress } from "./qr.ts";

// Five public rendezvous symbols plus twenty secret symbols (100 independent secret bits).
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function runnerPairCode(random: RandomBytes, relay?: string) {
  const bytes = random(25);
  if (bytes.length !== 25) throw new LinkError("invalid_pairing");
  const value = Array.from(bytes, (byte) => ALPHABET[byte & 31]).join("");
  bytes.fill(0);
  const code = value.match(/.{5}/g)?.join("-") ?? "";
  const address = relay ? relayAddress(relay, true) : undefined;
  return address && address !== "wss://relay.pibot.space"
    ? `${code}@${address.replace(/^wss:\/\//, "")}`
    : code;
}
export function decodeRunnerPairCode(input: string) {
  if (input.length > 1152) throw new LinkError("invalid_pairing");
  const [raw, address, extra] = input.trim().split("@");
  if (extra !== undefined || address === "") throw new LinkError("invalid_pairing");
  const relay =
    address === undefined
      ? undefined
      : relayAddress(address.startsWith("ws://") ? address : `wss://${address}`, true);
  const code = (raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== 25 || [...code].some((c) => !ALPHABET.includes(c)))
    throw new LinkError("invalid_pairing");
  const hint = code.slice(0, 5);
  return {
    hint,
    relay,
    psk: sha256(utf8(`pibot-runner-psk-v1:${code.slice(5)}`)),
    prologue: sha256(utf8(`pibot-runner-pair-v1:${hint}`)),
  };
}
export function runnerPairRoom(hint: string) {
  if (hint.length !== 5 || [...hint].some((c) => !ALPHABET.includes(c)))
    throw new LinkError("invalid_pairing");
  // This key is intentionally public routing material, unrelated to the secret code suffix.
  const key = sha256(utf8(`pibot-runner-rendezvous-v1:${hint}`));
  try {
    return roomTicket(key);
  } finally {
    key.fill(0);
  }
}
