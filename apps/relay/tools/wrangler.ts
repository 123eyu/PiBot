import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wranglerEnvironment } from "./wrangler-env.ts";

const relay = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(
  process.execPath,
  [join(relay, "node_modules", "wrangler", "bin", "wrangler.js"), ...process.argv.slice(2)],
  { cwd: relay, stdio: "inherit", env: await wranglerEnvironment(process.env) },
);
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.on("error", () => {
  console.error("wrangler_start_failed");
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  process.exitCode = code ?? 1;
});
