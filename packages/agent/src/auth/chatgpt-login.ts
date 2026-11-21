import { createHash, randomBytes } from "node:crypto";
import type { LoginOptions, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";
import {
  CHATGPT_CALLBACK_PATH,
  type ChatGPTAuthorization,
  ChatGPTSignInError,
  startChatGPTCallback,
} from "./chatgpt-callback.ts";
import { type ChatGPTIdTokenVerifier, createChatGPTIdTokenVerifier } from "./chatgpt-id-token.ts";
import { assertSupportedCredential } from "./claude-subscription.ts";

// Official Sign in with ChatGPT (developers.openai.com/siwc). `dynamic_agent_client` is only the
// registration entry: it is never stored and never exchanged for tokens.
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const CHATGPT_AGENT_NAME = "Pi Bot";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${CHATGPT_DIRECT_SCOPE}`;
// Refresh this long before the real expiry so a request never starts with a token about to lapse.
const EXPIRY_MARGIN_MS = 3 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[a-z0-9_.-]{1,80}$/i;

const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  scope: z.string().min(1),
  expires_in: z.number().finite().positive(),
});

export interface ChatGPTCredential extends OAuthCredential {
  clientId: string;
  scopes: string[];
  idToken: string;
  sub: string;
  account?: string;
}

function random() {
  return randomBytes(32).toString("base64url");
}

/** Only the OAuth error code survives; token endpoint bodies may echo credentials. */
async function requestToken(body: URLSearchParams, signal: AbortSignal) {
  // Global fetch at call time: the brain installs its proxy-aware transport there.
  const response = await globalThis.fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    const code = await response
      .json()
      .then((data: unknown) =>
        typeof data === "object" && data && "error" in data && typeof data.error === "string"
          ? data.error
          : undefined,
      )
      .catch(() => undefined);
    const error = new Error(
      `OpenAI token request failed (${response.status})${code && ERROR_CODE.test(code) ? `: ${code}` : ""}`,
    );
    Object.assign(error, { status: response.status, ...(code ? { code } : {}) });
    throw error;
  }
  return TokenSchema.parse(await response.json());
}

function grantedScopes(scope: string): string[] {
  const scopes = scope.trim().split(/\s+/).filter(Boolean);
  // Without direct token use the grant cannot call the Responses API on the user's plan.
  if (!scopes.includes(CHATGPT_DIRECT_SCOPE)) throw new AgentError("auth_failed");
  return scopes;
}

function manualAuthorization(
  input: string,
  redirectUri: string,
  state: string,
): ChatGPTAuthorization {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AgentError("auth_failed");
  }
  const expected = new URL(redirectUri);
  if (
    url.origin !== expected.origin ||
    url.pathname !== CHATGPT_CALLBACK_PATH ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.get("state") !== state
  )
    throw new AgentError("auth_failed");
  if (url.searchParams.has("error")) throw new ChatGPTSignInError("authorization_denied");
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!code || !clientId) throw new AgentError("auth_failed");
  return { code, clientId };
}

function stringField(credential: OAuthCredential | undefined, name: string): string | undefined {
  const value = credential?.[name];
  return typeof value === "string" && value ? value : undefined;
}

export interface ChatGPTAuthDeps {
  /** The stored credential for this installation, read before a new sign-in replaces it. */
  saved(signal: AbortSignal): Promise<OAuthCredential | undefined>;
  verifier?: ChatGPTIdTokenVerifier;
}

/**
 * pi's openai-chatgpt flow, completed to OpenAI's sign-in rules: a re-sign-in reuses the client ID
 * OpenAI issued to this account and must come back with the same ID and the same `sub`; the ID
 * token is verified against OpenAI's keys; a busy 1455 falls back to another loopback port; the ID
 * token and `sub` are kept (encrypted by the caller's store) for the account line and that check.
 */
export function chatGPTOAuth(deps: ChatGPTAuthDeps): OAuthAuth {
  const verifier = deps.verifier ?? createChatGPTIdTokenVerifier();
  return {
    name: "ChatGPT",
    isSubscription: true,
    loginLabel: "Continue with ChatGPT",
    async login(interaction, options?: LoginOptions): Promise<ChatGPTCredential> {
      const signal = interaction.signal;
      const deviceId = options?.getDeviceId?.();
      if (!deviceId || !UUID.test(deviceId)) throw new AgentError("internal");
      const saved = await deps.saved(signal);
      const savedClientId = stringField(saved, "clientId");
      const savedSub = stringField(saved, "sub");
      const verifierCode = random();
      const challenge = createHash("sha256").update(verifierCode).digest("base64url");
      const state = random();
      const nonce = random();
      const callback = await startChatGPTCallback(state, savedClientId);
      const manualAbort = new AbortController();
      try {
        const authorize = new URL(AUTHORIZE_URL);
        authorize.search = new URLSearchParams({
          client_id: savedClientId ?? DYNAMIC_CLIENT_ID,
          // The name hint only accompanies a first registration (SIWC sign-in rules).
          ...(savedClientId ? {} : { agent_name_hint: options?.agentName ?? CHATGPT_AGENT_NAME }),
          ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
          response_type: "code",
          redirect_uri: callback.redirectUri,
          resource: RESOURCE,
          scope: SCOPE,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          nonce,
        }).toString();
        interaction.notify({ type: "auth_url", url: authorize.toString() });
        const manual = interaction
          .prompt({
            type: "manual_code",
            message: "Paste the final redirect URL",
            placeholder: callback.redirectUri,
            signal: AbortSignal.any([manualAbort.signal, signal]),
          })
          .then((input) => manualAuthorization(input, callback.redirectUri, state));
        manual.catch(() => {});
        const { code, clientId } = await Promise.race([callback.result, manual]);
        if (savedClientId && clientId !== savedClientId)
          throw new ChatGPTSignInError("account_mismatch");
        const token = await requestToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: verifierCode,
            redirect_uri: callback.redirectUri,
            resource: RESOURCE,
          }),
          signal,
        );
        const scopes = grantedScopes(token.scope);
        if (!token.refresh_token || !token.id_token) throw new AgentError("auth_failed");
        const identity = await verifier.verify(token.id_token, { clientId, nonce }, signal);
        // The stored record belongs to one ChatGPT identity; another account must disconnect first.
        if (savedSub && identity.sub !== savedSub) throw new ChatGPTSignInError("account_mismatch");
        assertSupportedCredential(token.access_token);
        return {
          type: "oauth",
          access: token.access_token,
          refresh: token.refresh_token,
          expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
          clientId,
          scopes,
          idToken: token.id_token,
          sub: identity.sub,
          ...(identity.email ? { account: identity.email } : {}),
        };
      } catch (error) {
        if (signal.aborted) throw new AgentError("aborted");
        throw error;
      } finally {
        manualAbort.abort();
        callback.close();
      }
    },
    async refresh(credential, signal): Promise<ChatGPTCredential> {
      const clientId = stringField(credential, "clientId");
      const sub = stringField(credential, "sub");
      const idToken = stringField(credential, "idToken");
      // Records from before identity storage cannot prove which account they belong to.
      if (!clientId || !sub || !idToken) throw new AgentError("auth_failed");
      const token = await requestToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: credential.refresh,
          resource: RESOURCE,
        }),
        signal,
      );
      const scopes = grantedScopes(token.scope);
      let account = stringField(credential, "account");
      let nextIdToken = idToken;
      if (token.id_token) {
        // A refreshed ID token carries no nonce; it must still be signed for this client and user.
        const identity = await verifier.verify(token.id_token, { clientId }, signal);
        if (identity.sub !== sub) throw new AgentError("auth_failed");
        nextIdToken = token.id_token;
        account = identity.email ?? account;
      }
      assertSupportedCredential(token.access_token);
      return {
        type: "oauth",
        access: token.access_token,
        // The refresh token rotates; the whole set is replaced together (SIWC sign-in rules).
        refresh: token.refresh_token ?? credential.refresh,
        expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
        clientId,
        scopes,
        idToken: nextIdToken,
        sub,
        ...(account ? { account } : {}),
      };
    },
    async toAuth(credential) {
      assertSupportedCredential(credential.access);
      return { apiKey: credential.access };
    },
  };
}
