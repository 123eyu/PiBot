import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";

export const CHATGPT_CALLBACK_PATH = "/auth/callback";
// OpenAI registers 127.0.0.1 loopback callbacks where only the port may vary (SIWC sign-in rules).
// 1455 is the conventional port; Codex CLI or another pending login may already hold it.
const PREFERRED_PORT = 1455;

export interface ChatGPTAuthorization {
  code: string;
  clientId: string;
}

export interface ChatGPTCallback {
  readonly redirectUri: string;
  readonly result: Promise<ChatGPTAuthorization>;
  close(): void;
}

/** Thrown for a terminal callback rejection; the message is a fixed reason, never request data. */
export class ChatGPTSignInError extends Error {
  constructor(
    readonly reason: "account_mismatch" | "verification_failed" | "authorization_denied",
  ) {
    super(reason);
    this.name = "ChatGPTSignInError";
  }
}

export type ChatGPTSignInFailure = ChatGPTSignInError["reason"];

/** The fixed sign-in failure inside an SDK/runtime error chain, if any. */
export function chatGPTSignInFailure(error: unknown): ChatGPTSignInFailure | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ChatGPTSignInError) return current.reason;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function send(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

/**
 * The loopback listener for one sign-in. Requests without this attempt's state are answered and
 * ignored, so a stale browser tab or a probe from another app cannot end or steer the login.
 */
export async function startChatGPTCallback(
  state: string,
  expectedClientId?: string,
): Promise<ChatGPTCallback> {
  let settle!: { resolve(value: ChatGPTAuthorization): void; reject(error: Error): void };
  const result = new Promise<ChatGPTAuthorization>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller races this with manual input; a rejection nobody awaits must not crash the brain.
  result.catch(() => {});
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CHATGPT_CALLBACK_PATH) {
        send(response, 404, oauthErrorHtml("Callback route not found."));
        return;
      }
      if (request.method !== "GET" || url.searchParams.get("state") !== state) {
        send(response, 400, oauthErrorHtml("State mismatch."));
        return;
      }
      if (url.searchParams.has("error")) {
        send(response, 400, oauthErrorHtml("ChatGPT was not connected."));
        settle.reject(new ChatGPTSignInError("authorization_denied"));
        return;
      }
      const code = url.searchParams.get("code");
      const clientId = url.searchParams.get("client_id")?.trim();
      if (!code || !clientId) {
        send(response, 400, oauthErrorHtml("Invalid callback."));
        return;
      }
      if (expectedClientId && clientId !== expectedClientId) {
        send(response, 400, oauthErrorHtml("This ChatGPT account does not match this computer."));
        settle.reject(new ChatGPTSignInError("account_mismatch"));
        return;
      }
      send(
        response,
        200,
        oauthSuccessHtml("ChatGPT authorization received. You can close this window."),
      );
      settle.resolve({ code, clientId });
    } catch {
      send(response, 500, oauthErrorHtml("Internal error while processing the callback."));
    }
  };
  let server = createServer(handler);
  try {
    await listen(server, PREFERRED_PORT);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    // A failed listen leaves no socket behind; a fresh server takes any free loopback port.
    server = createServer(handler);
    await listen(server, 0);
  }
  server.on("error", (error) => settle.reject(error));
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}${CHATGPT_CALLBACK_PATH}`,
    result,
    close() {
      server.close();
      // Browsers keep spare connections open; one could carry a later login's callback here.
      server.closeAllConnections();
    },
  };
}
