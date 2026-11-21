import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../../../tools/dev/jsonc.ts";

export async function startRelay(root: string) {
  const pushes: unknown[] = [];
  const expo = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8192) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    try {
      pushes.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { status: "ok", id: "synthetic" } }));
    } catch {
      res.writeHead(400).end();
    }
  }).listen(0, "127.0.0.1");
  await once(expo, "listening");
  const ea = expo.address();
  if (!ea || typeof ea === "string") throw Error("expo_listen_failed");
  const reserve = createServer().listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const address = reserve.address();
  if (!address || typeof address === "string") throw Error("relay_listen_failed");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const config = parseJsonc(
    await readFile(new URL("../../../apps/relay/wrangler.jsonc", import.meta.url), "utf8"),
  );
  delete config.$schema;
  delete config.env;
  config.main = fileURLToPath(new URL("../../../tools/dev/relay/worker.mjs", import.meta.url));
  config.vars = {
    EXPO_ACCESS_TOKEN: "synthetic-only",
    FAKE_EXPO_URL: `http://127.0.0.1:${ea.port}`,
  };
  const path = join(root, "wrangler.json");
  await writeFile(path, JSON.stringify(config));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../../apps/relay/tools/wrangler.ts", import.meta.url)),
      "dev",
      "--config",
      path,
      "--ip",
      "127.0.0.1",
      "--port",
      String(address.port),
      "--persist-to",
      join(root, "relay"),
      "--log-level",
      "error",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        NO_PROXY: "127.0.0.1,localhost",
      },
    },
  );
  const exited = once(child, "exit");
  void exited.catch(() => {});
  // Wrangler's owner already handles telemetry/config paths; its raw diagnostics stay private.
  child.stdout.resume();
  child.stderr.resume();
  const close = async () => {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    expo.closeAllConnections();
    await new Promise<void>((resolve) => expo.close(() => resolve()));
  };
  try {
    const end = Date.now() + 40_000;
    for (;;) {
      if (child.exitCode !== null) throw Error("wrangler_exited");
      try {
        const response = await fetch(`${base}/_probe`, { signal: AbortSignal.timeout(500) });
        if ((await response.text()) === "pibot-probe-ready") break;
      } catch {
        /* Startup has not published the loopback listener yet. */
      }
      if (Date.now() > end) throw Error("wrangler_start_timeout");
      await wait(100);
    }
    return { base, pushes, close };
  } catch (error) {
    await close();
    throw error;
  }
}
