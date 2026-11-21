import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { z } from "zod";
import { mapAgentError } from "../core/errors.ts";
import { ChatGPTSignInError } from "./chatgpt-callback.ts";

// OpenAI's auth server for Sign in with ChatGPT. Verified tokens must name this issuer; the keys
// come from its published JWKS. Both are re-checked against the discovery document before the
// release gate opens.
export const CHATGPT_ISSUER = "https://auth.openai.com";
const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const CLOCK_SKEW_SECONDS = 60;
const JWKS_REFRESH_MS = 10 * 60_000;

const segment = /^[A-Za-z0-9_-]+$/;
const HeaderSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(200) });
const ClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1).max(255),
  aud: z.union([z.string(), z.array(z.string()).max(20)]),
  azp: z.string().optional(),
  exp: z.number().finite(),
  iat: z.number().finite().optional(),
  nonce: z.string().optional(),
  email: z.string().max(320).optional(),
});
const JwksSchema = z.object({
  keys: z
    .array(
      z.object({
        kty: z.string(),
        kid: z.string().max(200).optional(),
        use: z.string().optional(),
        alg: z.string().optional(),
        n: z.string().optional(),
        e: z.string().optional(),
      }),
    )
    .max(50),
});

export interface ChatGPTIdentity {
  sub: string;
  /** Shown as the signed-in account; never used to decide identity. */
  email?: string;
}

function decodeJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/**
 * Verifies OpenAI ID tokens with node:crypto (RS256 over the published JWKS) instead of adding a
 * JWT dependency. Keys are cached per verifier; an unknown kid refetches once for key rotation.
 */
export function createChatGPTIdTokenVerifier(now: () => number = Date.now) {
  let cache: { keys: Map<string, KeyObject>; at: number } | undefined;

  async function keys(signal: AbortSignal, force: boolean): Promise<Map<string, KeyObject>> {
    if (cache && !force && now() - cache.at < JWKS_REFRESH_MS) return cache.keys;
    // Global fetch at call time: the brain installs its proxy-aware transport there.
    const response = await globalThis.fetch(JWKS_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ChatGPTSignInError("verification_failed");
    }
    const parsed = JwksSchema.parse(await response.json());
    const map = new Map<string, KeyObject>();
    for (const key of parsed.keys) {
      if (key.kty !== "RSA" || !key.kid || !key.n || !key.e) continue;
      if (key.use !== undefined && key.use !== "sig") continue;
      if (key.alg !== undefined && key.alg !== "RS256") continue;
      map.set(key.kid, createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" }));
    }
    cache = { keys: map, at: now() };
    return map;
  }

  async function check(
    token: string,
    expected: { clientId: string; nonce?: string },
    signal: AbortSignal,
  ): Promise<ChatGPTIdentity> {
    const parts = token.split(".");
    const [rawHeader, rawClaims, rawSignature] = parts;
    if (
      parts.length !== 3 ||
      !rawHeader ||
      !rawClaims ||
      !rawSignature ||
      !parts.every((part) => segment.test(part))
    )
      throw new ChatGPTSignInError("verification_failed");
    const header = HeaderSchema.parse(decodeJson(rawHeader));
    let key = (await keys(signal, false)).get(header.kid);
    key ??= (await keys(signal, true)).get(header.kid);
    if (!key) throw new ChatGPTSignInError("verification_failed");
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${rawHeader}.${rawClaims}`),
      key,
      Buffer.from(rawSignature, "base64url"),
    );
    if (!signed) throw new ChatGPTSignInError("verification_failed");
    const claims = ClaimsSchema.parse(decodeJson(rawClaims));
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const seconds = now() / 1000;
    if (
      claims.iss !== CHATGPT_ISSUER ||
      !audiences.includes(expected.clientId) ||
      // OIDC: with several audiences the authorized party must be this client.
      (audiences.length > 1 && claims.azp !== expected.clientId) ||
      claims.exp <= seconds - CLOCK_SKEW_SECONDS ||
      (claims.iat !== undefined && claims.iat > seconds + CLOCK_SKEW_SECONDS) ||
      (expected.nonce !== undefined && claims.nonce !== expected.nonce)
    )
      throw new ChatGPTSignInError("verification_failed");
    return { sub: claims.sub, ...(claims.email ? { email: claims.email } : {}) };
  }

  return {
    async verify(
      token: string,
      expected: { clientId: string; nonce?: string },
      signal: AbortSignal,
    ): Promise<ChatGPTIdentity> {
      try {
        return await check(token, expected, signal);
      } catch (error) {
        if (signal.aborted || error instanceof ChatGPTSignInError) throw error;
        // An unreachable key server is retryable; it says nothing about the token.
        if (mapAgentError(error) === "network") throw error;
        // Malformed JSON, schema or key material all mean the same thing: do not trust it.
        throw new ChatGPTSignInError("verification_failed");
      }
    },
  };
}
export type ChatGPTIdTokenVerifier = ReturnType<typeof createChatGPTIdTokenVerifier>;
