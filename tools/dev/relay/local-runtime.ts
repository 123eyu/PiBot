import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wranglerEnvironment } from "../../../apps/relay/tools/wrangler-env.ts";
import { parseJsonc } from "../jsonc.ts";

const relay = fileURLToPath(new URL("../../../apps/relay/", import.meta.url));
export async function startRuntime(memory = false) {
  const environment = await wranglerEnvironment(process.env);
  const requests: { authorization: string | undefined; body: unknown }[] = [];
  const expo = createServer(async (request, response) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { status: "ok", id: "probe" } }));
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  expo.listen(0, "127.0.0.1");
  await once(expo, "listening");
  const expoAddress = expo.address();
  if (!expoAddress || typeof expoAddress === "string") throw new Error("probe_listen_failed");
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const address = reserve.address();
  if (!address || typeof address === "string") throw new Error("probe_listen_failed");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const directory = await mkdtemp(join(environment.XDG_CONFIG_HOME, "probe-"));
  const config = parseJsonc(await readFile(join(relay, "wrangler.jsonc"), "utf8"));
  delete config.$schema;
  delete config.env;
  config.main = fileURLToPath(new URL("./worker.mjs", import.meta.url));
  config.vars = {
    EXPO_ACCESS_TOKEN: "probe-only-access-token",
    FAKE_EXPO_URL: `http://127.0.0.1:${expoAddress.port}`,
    STATS_TOKEN: "probe-only-stats-token-0000",
  };
  if (memory) config.ratelimits = [];
  const configPath = join(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(
    process.execPath,
    [
      join(relay, "node_modules", "wrangler", "bin", "wrangler.js"),
      "dev",
      "--config",
      configPath,
      "--ip",
      "127.0.0.1",
      "--port",
      String(address.port),
      "--log-level",
      "error",
      "--persist-to",
      join(directory, "runtime"),
    ],
    {
      cwd: relay,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...environment,
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
  let diagnostics = "";
  child.stdout?.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-8000);
  });
  child.stderr?.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-8000);
  });
  const stopped = once(child, "exit");
  const close = async () => {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(timer);
    expo.closeAllConnections();
    await new Promise<void>((resolve) => expo.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const deadline = Date.now() + 45_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error("wrangler_exited");
      try {
        const response = await fetch(`${base}/_probe`, { signal: AbortSignal.timeout(1000) });
        if ((await response.text()) === "pibot-probe-ready") break;
      } catch {
        /* Local startup has not published its listener yet. */
      }
      if (Date.now() > deadline) throw new Error("wrangler_start_timeout");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await close();
    console.error(diagnostics.replaceAll("probe-only-access-token", "[REDACTED]"));
    throw error;
  }
  return { base, requests, close };
}
