import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";

const schema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  }),
  z.strictObject({ action: z.literal("wait"), session: z.string().max(64) }),
  z.strictObject({ action: z.literal("cancel") }),
]);

/** Own the listener in the host instead of granting a plugin arbitrary local binding. */
export function createPluginOAuthLoopback(signal: AbortSignal) {
  let starting = false;
  let active: { id: string; result: Promise<{ code: string }>; close(): void } | undefined;
  const close = () => {
    active?.close();
    active = undefined;
  };
  signal.addEventListener("abort", close, { once: true });
  return {
    close() {
      signal.removeEventListener("abort", close);
      close();
    },
    async handle(input: unknown) {
      const params = schema.parse(input);
      signal.throwIfAborted();
      if (params.action === "cancel") {
        close();
        return {};
      }
      if (params.action === "wait") {
        const session = active;
        if (!session || session.id !== params.session) throw new Error("oauth_session_unavailable");
        try {
          return await session.result;
        } finally {
          if (active === session) active = undefined;
          session.close();
        }
      }
      if (starting || active) throw new Error("oauth_session_busy");
      starting = true;
      let resolveCode!: (value: { code: string }) => void;
      let rejectCode!: (error: Error) => void;
      const result = new Promise<{ code: string }>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      });
      void result.catch(() => undefined); // Timeout may precede the plugin's wait request.
      let consumed = false;
      const server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const expected = Buffer.from(params.state);
        if (!["GET", "POST"].includes(req.method ?? "") || url.pathname !== "/oauth/callback") {
          res.writeHead(400).end("Invalid callback.");
          return;
        }
        if (consumed) {
          res.writeHead(409).end("Callback already received.");
          return;
        }
        const finish = (code: string | null, stateValue: string | null) => {
          const state = Buffer.from(stateValue ?? "");
          if (state.length !== expected.length || !timingSafeEqual(state, expected)) {
            res.writeHead(400).end("Invalid callback.");
            return;
          }
          // Only a callback that proves ownership of this session may consume it. Invalid
          // loopback traffic is common on shared desktops and must not deny the real callback.
          if (consumed) {
            res.writeHead(409).end("Callback already received.");
            return;
          }
          consumed = true;
          if (!code || code.length > 4096) rejectCode(new Error("oauth_authorization_denied"));
          else resolveCode({ code });
          res.end("Authorization received. Return to Pi Bot. / 已收到授权，请返回 Pi Bot。");
          server.close();
        };
        if (req.method === "GET") {
          finish(url.searchParams.get("code"), url.searchParams.get("state"));
          return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8192) req.destroy();
        });
        req.on("end", () => {
          const form = new URLSearchParams(body);
          finish(form.get("code"), form.get("state"));
        });
      });
      server.requestTimeout = 10000;
      server.headersTimeout = 10000;
      const stop = () => {
        clearTimeout(timer);
        server.closeAllConnections();
        server.close();
        rejectCode(new Error("oauth_authorization_cancelled"));
      };
      const timer = setTimeout(() => {
        stop();
        active = undefined;
      }, 5 * 60_000);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        signal.throwIfAborted();
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("oauth_callback_unavailable");
        const id = randomBytes(24).toString("hex");
        active = { id, result, close: stop };
        return { session: id, redirectUri: `http://127.0.0.1:${address.port}/oauth/callback` };
      } catch {
        stop();
        throw new Error("oauth_callback_unavailable");
      } finally {
        starting = false;
      }
    },
  };
}
