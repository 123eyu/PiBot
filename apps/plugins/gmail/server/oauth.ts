import type { PluginHost, PluginSecrets } from "@pibot/plugin-sdk";
import { createOAuthApi } from "./oauth-api.ts";
import { createOAuthHttp, stringField } from "./oauth-http.ts";

type Options = {
  proxy: string;
  host: PluginHost;
  secrets: PluginSecrets;
  signal: AbortSignal;
  compose(args: Record<string, unknown>): Promise<Buffer>;
  onEmail?(email: string): void;
};

function scopes(names: string[]): string {
  const base = "https://www.googleapis.com/auth/";
  if (names.includes("modify_labels")) return `${base}gmail.modify`;
  const result = [];
  if (names.some((name) => ["search_messages", "read_message", "read_thread"].includes(name)))
    result.push(`${base}gmail.readonly`);
  if (names.includes("create_draft")) result.push(`${base}gmail.compose`);
  else if (names.includes("send_message")) result.push(`${base}gmail.send`);
  if (names.includes("list_labels") && result.length === 0) result.push(`${base}gmail.labels`);
  // gmail.send alone does not authorize labels.list.
  if (names.includes("list_labels") && result.length === 1 && result[0] === `${base}gmail.send`)
    result.push(`${base}gmail.labels`);
  return result.join(" ");
}

export function createOAuthRuntime(options: Options) {
  const { host, secrets, signal: lifetime } = options;
  const controller = new AbortController();
  const signal = AbortSignal.any([lifetime, controller.signal]);
  const http = createOAuthHttp(options.proxy);
  const api = createOAuthApi({
    ...options,
    http,
    clientId: async () => (await secrets.get("gmail.oauth.client_id")) ?? "",
  });
  let pending: { stop: AbortController; work: Promise<void> } | undefined;
  let changing = false;
  let status: "idle" | "pending" | "authorized" | "failed" = "idle";

  async function cancel() {
    const current = pending;
    current?.stop.abort();
    await host.cancelOAuthCallback();
    await current?.work;
  }
  async function start(requestSignal: AbortSignal) {
    if (pending || (await secrets.get("gmail.oauth.refresh")))
      throw new Error("gmail_oauth_already_pending_or_connected");
    const scope = scopes(await host.enabledTools());
    if (!scope) throw new Error("gmail_oauth_no_enabled_tools");
    // Web Crypto: plugins may not import node: modules (domain boundaries); same strength.
    const verifier = randomToken();
    const state = randomToken();
    const challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");
    const { session, redirectUri } = await host.startOAuthCallback(state);
    if (requestSignal.aborted || signal.aborted) {
      await host.cancelOAuthCallback();
      throw new Error("gmail_oauth_cancelled");
    }
    const startSignal = AbortSignal.any([signal, requestSignal, AbortSignal.timeout(20000)]);
    let authStart: Record<string, unknown>;
    try {
      authStart = await http.json(
        "https://auth.pibot.space/gmail/start",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uri: redirectUri,
            state,
            code_challenge: challenge,
            code_verifier: verifier,
            scope,
          }),
        },
        startSignal,
      );
    } catch (error) {
      await host.cancelOAuthCallback();
      throw error;
    }
    const authorizationUrl = stringField(authStart, "authorizationUrl", 4096);
    const clientId = stringField(authStart, "clientId", 512);
    status = "pending";
    const stop = new AbortController();
    const work = (async () => {
      try {
        const { code } = await host.waitOAuthCallback(session);
        const exchangeSignal = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(20000)]);
        exchangeSignal.throwIfAborted();
        const credentials = await decryptRefresh(code, verifier);
        const refresh = credentials.refresh;
        exchangeSignal.throwIfAborted();
        await secrets.set("gmail.oauth.refresh", refresh);
        await secrets.set("gmail.oauth.client_id", clientId);
        await secrets.set("gmail.oauth.email", credentials.email);
        options.onEmail?.(credentials.email);
        status = "authorized";
      } catch {
        status = "failed"; // Fixed status only: token responses and callback codes never escape.
      } finally {
        pending = undefined;
      }
    })();
    pending = { stop, work };
    try {
      await host.openExternal(authorizationUrl);
    } catch (error) {
      stop.abort();
      await host.cancelOAuthCallback();
      await work;
      throw error;
    }
    return {
      authorizationUrl,
      expiresInSeconds: 300,
      message:
        "已打开系统浏览器，请登录 Google 并授权；授权结果只通过一次性回环票据返回本机。 / The system browser is open; sign in to Google and authorize. A one-time loopback ticket returns the result to this device.",
    };
  }
  return {
    async call(tool: string, args: Record<string, unknown>, requestSignal: AbortSignal) {
      if (changing) throw new Error("gmail_oauth_busy");
      const callSignal = AbortSignal.any([signal, requestSignal]);
      if (tool === "oauth_status")
        return {
          status,
          pending: !!pending,
          authorized: !!(await secrets.get("gmail.oauth.refresh")),
        };
      if (tool === "oauth_start" || tool === "oauth_revoke") {
        changing = true;
        try {
          if (tool === "oauth_start") return await start(callSignal);
          await cancel();
          const refresh = await secrets.get("gmail.oauth.refresh");
          // Clear locally before networking: failed revocation must not keep the old account active.
          await secrets.delete("gmail.oauth.refresh");
          await secrets.delete("gmail.oauth.client_id");
          await secrets.delete("gmail.oauth.email");
          status = "idle";
          let revoked = !refresh;
          try {
            if (refresh) {
              await http.json(
                "https://oauth2.googleapis.com/revoke",
                {
                  method: "POST",
                  body: new URLSearchParams({ token: refresh }),
                },
                callSignal,
              );
              revoked = true;
            }
          } catch {
            // Report remote revocation failure explicitly while local sign-out remains complete.
          }
          return { cleared: true, revoked };
        } finally {
          changing = false;
        }
      }
      try {
        return await api(tool, args, callSignal);
      } catch (error) {
        if (error instanceof Error && error.message === "gmail_oauth_authorization_required")
          throw error;
        throw new Error(
          tool === "send_message"
            ? "gmail_send_status_unknown / Check Sent mail; do not retry automatically / 发送状态未知，请核对已发送邮件，不要自动重试"
            : "gmail_request_failed",
        );
      }
    },
    async close() {
      controller.abort();
      pending?.stop.abort();
      await http.close();
      // The connector host closes its listener on stream disposal; that also settles wait.
    },
  };
}

/** 32 random bytes as base64url (PKCE verifier / OAuth state). */
function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

async function decryptRefresh(
  envelope: string,
  verifier: string,
): Promise<{ refresh: string; email: string }> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("gmail_oauth_ticket_invalid");
  const ivPart = parts[1];
  const cipherPart = parts[2];
  if (!ivPart || !cipherPart) throw new Error("gmail_oauth_ticket_invalid");
  const decode = (value: string) => Buffer.from(value, "base64url");
  const keyBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`Pi Bot Gmail ticket v1\0${verifier}`),
  );
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(ivPart) },
    key,
    decode(cipherPart),
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error("gmail_oauth_ticket_invalid");
  }
  if (!value || typeof value !== "object") throw new Error("gmail_oauth_ticket_invalid");
  const refresh = (value as { refresh?: unknown }).refresh;
  const email = (value as { email?: unknown }).email;
  if (
    typeof refresh !== "string" ||
    !/^\S{20,4096}$/.test(refresh) ||
    typeof email !== "string" ||
    !/^[^\s@]+@[^\s@]+$/.test(email)
  )
    throw new Error("gmail_oauth_ticket_invalid");
  return { refresh, email };
}
