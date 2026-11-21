import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { requireThat } from "./assert.ts";
import type { budget } from "./options.ts";

/** A receiving boundary also covers SDKs that captured fetch before the harness loaded. */
export async function realRelay(
  baseUrl: string,
  ledger: ReturnType<typeof budget>,
  observe: (body: Record<string, unknown>) => void,
  signal: AbortSignal,
) {
  const upstream = new URL(baseUrl);
  const prefix = upstream.pathname.replace(/\/$/u, "");
  const lifecycle = new AbortController();
  const server = createServer(async (req, res) => {
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    res.once("close", abort);
    try {
      const target = new URL(req.url ?? "", upstream.origin);
      requireThat(
        req.method === "POST" &&
          target.origin === upstream.origin &&
          target.pathname.startsWith(`${prefix}/`),
        "relay_route_denied",
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        requireThat(size <= 2_000_000, "request_body_unbounded");
        chunks.push(Buffer.from(chunk));
      }
      const payload = Buffer.concat(chunks).toString("utf8");
      const body: unknown = JSON.parse(payload);
      requireThat(
        body !== null && typeof body === "object" && !Array.isArray(body),
        "request_shape",
      );
      observe(body as Record<string, unknown>);
      // Charge every attempt before dispatch, including SDK retries. No refund or cache discount.
      ledger.reserve(payload);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (["host", "content-length", "connection", "transfer-encoding"].includes(name)) continue;
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      }
      const response = await fetch(target, {
        method: "POST",
        headers,
        body: payload,
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          lifecycle.signal,
          disconnected.signal,
          AbortSignal.timeout(90_000),
        ]),
      });
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
      });
      if (response.body) {
        const reader = response.body.getReader();
        try {
          await pipeline(
            (async function* () {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                yield value;
              }
            })(),
            res,
          );
        } finally {
          reader.releaseLock();
        }
      } else res.end();
    } catch {
      // Provider errors can contain credentials or content; only a constant crosses this boundary.
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":{"message":"memory_acceptance_transport_failed"}}');
    } finally {
      res.off("close", abort);
    }
  });
  server.requestTimeout = 95_000;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  });
  const address = server.address();
  requireThat(address && typeof address === "object", "relay_address_missing");
  return {
    url: `http://127.0.0.1:${address.port}${prefix}`,
    async stop() {
      lifecycle.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
