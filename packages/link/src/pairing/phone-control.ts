import {
  type PhoneControlBody,
  type PhoneControlGrant,
  PhoneControlGrantSchema,
} from "@pibot/protocol-base";
import { base64url, LinkError, unbase64, utf8 } from "../core/bytes.ts";
import { type EndpointKeys, sign, verify } from "../keys/endpoint.ts";
import { runnerDeviceId } from "../room/runner.ts";

// A fixed tuple, rather than JSON object insertion order, defines the signed wire format.
function signedBytes(b: PhoneControlBody) {
  return utf8(
    JSON.stringify([
      "pibot-phone-runner-control-v1",
      b.version,
      b.issuer,
      b.phone,
      b.runner,
      b.runnerId,
      b.revision,
      b.rotation,
      b.issuedAt,
      b.expiresAt,
      b.enabled,
      b.capabilities,
      b.stunUrl,
    ]),
  );
}
export function signPhoneControl(keys: EndpointKeys, body: PhoneControlBody): PhoneControlGrant {
  if (body.issuer !== base64url(keys.signingPublic)) throw new LinkError("invalid_identity");
  return PhoneControlGrantSchema.parse({
    body,
    signature: base64url(sign(keys, signedBytes(body))),
  });
}
export function verifyPhoneControl(
  value: unknown,
  issuer: string,
  runner?: string,
): PhoneControlGrant {
  const parsed = PhoneControlGrantSchema.safeParse(value);
  if (!parsed.success) throw new LinkError("invalid_authorization");
  const grant = parsed.data;
  const b = grant.body;
  if (
    b.issuer !== issuer ||
    (runner && b.runner !== runner) ||
    runnerDeviceId(unbase64(b.runner, 32)) !== b.runnerId ||
    !verify(unbase64(issuer, 32), signedBytes(b), unbase64(grant.signature, 64))
  )
    throw new LinkError("invalid_authorization");
  return grant;
}
export function assertPhoneControlCurrent(grant: PhoneControlGrant, now = Date.now()) {
  if (!grant.body.enabled || grant.body.issuedAt > now + 60_000 || grant.body.expiresAt <= now)
    throw new LinkError("authorization_expired");
}
