import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equal, LinkError, type RandomBytes, requireBytes, utf8 } from "../core/bytes.ts";
export interface EndpointKeys {
  secret: Uint8Array;
  signingPublic: Uint8Array;
  dhSecret: Uint8Array;
  dhPublic: Uint8Array;
}
export function endpointKeys(secret: Uint8Array): EndpointKeys {
  const seed = requireBytes(secret, 32).slice();
  const dhSecret = ed25519.utils.toMontgomerySecret(seed);
  return {
    secret: seed,
    signingPublic: ed25519.getPublicKey(seed),
    dhSecret,
    dhPublic: x25519.getPublicKey(dhSecret),
  };
}
export function createEndpoint(random: RandomBytes) {
  return endpointKeys(random(32));
}
export function dhPublic(signingPublic: Uint8Array) {
  try {
    return ed25519.utils.toMontgomery(requireBytes(signingPublic, 32));
  } catch {
    throw new LinkError("invalid_identity");
  }
}
export function sharedSecret(local: EndpointKeys, remoteSigning: Uint8Array) {
  try {
    return x25519.getSharedSecret(local.dhSecret, dhPublic(remoteSigning));
  } catch {
    throw new LinkError("invalid_identity");
  }
}
export function sign(keys: EndpointKeys, message: Uint8Array) {
  return ed25519.sign(message, keys.secret);
}
export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
export function safetyCode(first: Uint8Array, second: Uint8Array) {
  requireBytes(first, 32);
  requireBytes(second, 32);
  const ordered = [...first].findIndex((byte, i) => byte !== second[i]);
  const swap = ordered >= 0 && (first[ordered] as number) > (second[ordered] as number);
  const digest = sha256(
    concat(utf8("pibot-safety-v1"), swap ? second : first, swap ? first : second),
  );
  let value = 0n;
  for (const byte of digest) value = (value << 8n) | BigInt(byte);
  return (value % 1_000_000n).toString().padStart(6, "0");
}
export function destroyEndpoint(keys: EndpointKeys) {
  keys.secret.fill(0);
  keys.dhSecret.fill(0);
}
export function checkIdentity(signing: Uint8Array, expectedDh: Uint8Array) {
  if (!equal(dhPublic(signing), expectedDh)) throw new LinkError("identity_mismatch");
}
