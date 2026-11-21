import { base64url, concat, equal, LinkError, unbase64, utf8 } from "../core/bytes.ts";
import { checkIdentity, type EndpointKeys, sign, verify } from "../keys/endpoint.ts";
import type { NoiseChannel } from "../noise/channel.ts";
import { deviceName } from "./qr.ts";
export interface IdentityProof {
  name: string;
  publicKey: string;
  signature: string;
}
const challenge = (binding: Uint8Array, name: string) =>
  concat(utf8("pibot-pair-identity-v1:"), binding, utf8(name));
export function identityProof(
  keys: EndpointKeys,
  channel: NoiseChannel,
  name: string,
): IdentityProof {
  deviceName(name);
  return {
    name,
    publicKey: base64url(keys.signingPublic),
    signature: base64url(sign(keys, challenge(channel.binding, name))),
  };
}
export function acceptIdentity(
  value: unknown,
  channel: NoiseChannel,
  expectedSigning?: Uint8Array,
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LinkError("invalid_identity");
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).sort().join(",") !== "name,publicKey,signature" ||
    typeof p.name !== "string" ||
    typeof p.publicKey !== "string" ||
    typeof p.signature !== "string"
  )
    throw new LinkError("invalid_identity");
  deviceName(p.name);
  const publicKey = unbase64(p.publicKey, 32);
  if (expectedSigning && !equal(publicKey, expectedSigning))
    throw new LinkError("identity_mismatch");
  checkIdentity(publicKey, channel.remoteStatic);
  if (!verify(publicKey, challenge(channel.binding, p.name), unbase64(p.signature, 64)))
    throw new LinkError("invalid_identity");
  return { name: p.name, publicKey };
}
// Reserve before sending the responder message; commit only after the encrypted identity proof.
export function pairingLease(psk: Uint8Array, expiresAt: number, now = Date.now) {
  let claimed = false,
    finished = false;
  const assert = () => {
    if (finished || now() >= expiresAt) throw new LinkError("pairing_unavailable");
  };
  return {
    claim() {
      assert();
      if (claimed) throw new LinkError("pairing_unavailable");
      claimed = true;
      return psk.slice();
    },
    commit() {
      assert();
      if (!claimed) throw new LinkError("pairing_unavailable");
      finished = true;
      psk.fill(0);
    },
    dispose() {
      finished = true;
      psk.fill(0);
    },
  };
}
