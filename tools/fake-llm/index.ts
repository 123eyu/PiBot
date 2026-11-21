import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fail, runtimeDirectory } from "../dev/process.ts";
import { streamResponsesReply } from "./responses.ts";
import { loadScenario, type Scenario } from "./scenario.ts";
import { openAIReply, streamReply } from "./stream.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export async function startFakeLlm(opts: {
  port: number;
  scenario: Scenario;
  logDirectory: string;
  observe?: (body: Record<string, unknown>, route: string, index: number) => void;
  /** Separate auxiliary requests without consuming the scripted task replies. */
  route?: (body: Record<string, unknown>) => string | undefined;
  /** Image probe: hold the n-th image response this long (a service that never answers in time). */
  imageDelayMs?: (index: number) => number;
}) {
  const { port, scenario, logDirectory } = opts;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const indexes = new Map<string, number>();
  let logChain = Promise.resolve();
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      let bytes = 0;
      const parts: Buffer[] = [];
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 2 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        parts.push(part);
      }
      let body: Record<string, unknown> = {};
      if (bytes) {
        const parsed: unknown = JSON.parse(Buffer.concat(parts).toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Body must be an object.");
        body = parsed as Record<string, unknown>;
      }
      const record = {
        at: new Date().toISOString(),
        method: req.method,
        path: [
          "/v1/models",
          "/v1/chat/completions",
          "/v1/responses",
          "/api/tags",
          "/api/chat",
        ].includes(path)
          ? path
          : "other",
        bytes,
        authorizationPresent: Boolean(req.headers.authorization),
        messageCount: Array.isArray(body.messages)
          ? body.messages.length
          : Array.isArray(body.input)
            ? body.input.length
            : 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        stream: body.stream === true,
      };
      // Intentionally record structure only: no auth values, prompts, tool arguments, query strings or cookies.
      logChain = logChain.then(() =>
        appendFile(join(logDirectory, "requests.jsonl"), `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        }),
      );
      await logChain;
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            data: [{ id: "fake-model", object: "model", created: 0, owned_by: "pibot" }],
          }),
        );
        return;
      }
      if (req.method === "GET" && path === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            models: [
              {
                name: "fake-model",
                model: "fake-model",
                modified_at: new Date().toISOString(),
                size: 0,
                digest: "fake",
                details: { family: "fake", parameter_size: "0B", quantization_level: "none" },
              },
            ],
          }),
        );
        return;
      }
      if (req.method === "POST" && path === "/v1/images/generations") {
        // Image probe: an OpenAI-style image service answering one 1x1 PNG; the body reaches
        // only the in-process observer, never the structural request log.
        const index = indexes.get("images") ?? 0;
        indexes.set("images", index + 1);
        opts.observe?.(body, "images", index);
        const delay = opts.imageDelayMs?.(index) ?? 0;
        if (delay > 0) {
          // Stop holding as soon as the client gives up, so the server can close promptly.
          await new Promise<void>((done) => {
            const timer = setTimeout(done, delay);
            res.once("close", () => {
              clearTimeout(timer);
              done();
            });
          });
          if (res.destroyed) return;
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }));
        return;
      }
      if (
        req.method !== "POST" ||
        !["/v1/chat/completions", "/v1/responses", "/api/chat"].includes(path)
      ) {
        res.writeHead(404).end();
        return;
      }
      const responses = path === "/v1/responses";
      if (!Array.isArray(responses ? body.input : body.messages))
        throw new Error("messages must be an array.");
      const selected = opts.route?.(body);
      if (selected !== undefined && !Object.hasOwn(scenario.routes ?? {}, selected))
        throw new Error("Unknown fake model route.");
      const route =
        selected ??
        (typeof body.model === "string" && Object.hasOwn(scenario.routes ?? {}, body.model)
          ? body.model
          : "default");
      const index = indexes.get(route) ?? 0;
      indexes.set(route, index + 1);
      opts.observe?.(body, route, index);
      const reply = (route === "default" ? scenario.replies : scenario.routes?.[route])?.[
        index
      ] ?? { text: "场景执行完毕。" };
      const id = randomUUID();
      if (reply.disconnect === "before") {
        res.destroy();
        return;
      }
      if (reply.httpError) {
        res
          .writeHead(
            reply.httpError === "rate_limited"
              ? 429
              : reply.httpError === "provider_error"
                ? 503
                : 400,
            {
              "content-type": "application/json",
              ...(reply.retryAfter ? { "retry-after": reply.retryAfter } : {}),
            },
          )
          .end(
            JSON.stringify({
              error: {
                message:
                  reply.httpError === "rate_limited"
                    ? "rate limited"
                    : reply.httpError === "provider_error"
                      ? "provider error"
                      : "context length exceeded",
                type: "invalid_request_error",
                code: reply.httpError,
              },
            }),
          );
        return;
      }
      // Keep response metadata aligned with the explicitly selected fixture model.
      const model =
        typeof body.model === "string" && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(body.model)
          ? body.model
          : "fake-model";
      if (responses) await streamResponsesReply(res, reply, id, model, bytes);
      else if (body.stream !== false)
        await streamReply(res, reply, id, model, path === "/api/chat");
      else
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify(
            path === "/api/chat"
              ? {
                  model,
                  message: {
                    role: "assistant",
                    content: reply.text ?? "",
                    ...(reply.toolCalls
                      ? { tool_calls: reply.toolCalls.map((tool) => ({ function: tool })) }
                      : {}),
                  },
                  done: true,
                }
              : openAIReply(reply, id, model),
          ),
        );
    } catch (error) {
      if (!res.headersSent)
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              message: error instanceof SyntaxError ? "Invalid JSON" : "Request rejected",
            },
          }),
        );
      else res.destroy();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      ready();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address.");
  const stop = async () => {
    const closed = new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    server.closeAllConnections();
    await closed;
    await logChain;
  };
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop,
    counts: () => Object.fromEntries(indexes),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "8000" },
      scenario: { type: "string", default: "text" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const server = await startFakeLlm({
    port,
    scenario: await loadScenario(values.scenario ?? "text"),
    logDirectory: join(runtimeDirectory, "fake-llm"),
  });
  console.log(`Fake LLM: ${server.url} scenario=${values.scenario} (restart to reset sequence)`);
  const stop = () => {
    void server.stop().catch(fail);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(fail);
