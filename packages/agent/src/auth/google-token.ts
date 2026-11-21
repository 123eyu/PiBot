import { createHash, sign } from "node:crypto";
import { z } from "zod";
import { AgentError, mapAgentError } from "../core/errors.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// Refresh early so a long stream never starts with a token that expires mid-request.
const EARLY_MS = 5 * 60_000;

const credentialsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("service_account"),
    client_email: z.string().min(1),
    private_key: z.string().min(1),
    private_key_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("authorized_user"),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    refresh_token: z.string().min(1),
  }),
]);
const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  expires_in: z.coerce.number().int().positive().max(86_400),
});

export interface GoogleTokenSource {
  token(credentials: Record<string, string>, signal: AbortSignal): Promise<string>;
}

/**
 * Pi Bot exchanges the stored Google credential itself, over the global fetch the brain routes
 * through the user's proxy. google-auth-library's gaxios transport uses node-fetch and would
 * reach oauth2.googleapis.com directly, bypassing a manual proxy.
 */
export function createGoogleTokenSource(now: () => number = Date.now): GoogleTokenSource {
  // Keyed by a digest so the cache never holds a second copy of the long-lived secret.
  const cache = new Map<string, { token: string; expires: number }>();
  const pending = new Map<string, Promise<{ token: string; expires: number }>>();
  return {
    async token(raw, signal) {
      signal.throwIfAborted();
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) throw new AgentError("auth_failed");
      const credentials = parsed.data;
      const key = createHash("sha256")
        .update(
          credentials.type === "service_account"
            ? `sa\0${credentials.client_email}\0${credentials.private_key}`
            : `user\0${credentials.client_id}\0${credentials.refresh_token}`,
        )
        .digest("hex");
      const cached = cache.get(key);
      if (cached && cached.expires - EARLY_MS > now()) return cached.token;
      let exchange = pending.get(key);
      if (!exchange) {
        // One exchange serves concurrent callers; it has its own deadline so one caller's
        // cancellation does not fail the others.
        exchange = request(credentials, now).finally(() => pending.delete(key));
        pending.set(key, exchange);
      }
      const result = await abortable(exchange, signal);
      // A small, fixed set of credentials per brain; drop expired rows instead of growing.
      for (const [id, entry] of cache) if (entry.expires <= now()) cache.delete(id);
      cache.set(key, result);
      return result.token;
    },
  };
}

async function request(credentials: z.infer<typeof credentialsSchema>, now: () => number) {
  const body = new URLSearchParams();
  if (credentials.type === "authorized_user") {
    body.set("grant_type", "refresh_token");
    body.set("client_id", credentials.client_id);
    body.set("client_secret", credentials.client_secret);
    body.set("refresh_token", credentials.refresh_token);
  } else {
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    body.set("assertion", assertion(credentials, now));
  }
  const started = now();
  // Resolved at call time: the brain installs the proxied transport as the global fetch.
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    // Never forward a refresh token or signed assertion to another origin.
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    // invalid_grant / revoked client returns 400; it is a credential problem, not a bad request.
    const code =
      response.status === 400 ? "auth_failed" : mapAgentError({ status: response.status });
    throw new AgentError(code === "internal" ? "provider_error" : code, response.status);
  }
  const text = await response.text();
  if (text.length > 65_536) throw new AgentError("provider_error");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AgentError("provider_error");
  }
  const token = tokenSchema.safeParse(value);
  if (!token.success) throw new AgentError("provider_error");
  return { token: token.data.access_token, expires: started + token.data.expires_in * 1000 };
}

function assertion(
  credentials: Extract<z.infer<typeof credentialsSchema>, { type: "service_account" }>,
  now: () => number,
) {
  const iat = Math.floor(now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({
    alg: "RS256",
    typ: "JWT",
    ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {}),
  })}.${encode({
    iss: credentials.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  })}`;
  try {
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), credentials.private_key).toString("base64url")}`;
  } catch {
    // The key was validated at save time; a signing failure must not echo key material.
    throw new AgentError("auth_failed");
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
