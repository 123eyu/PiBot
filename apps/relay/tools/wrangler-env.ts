import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function wranglerEnvironment(parent: NodeJS.ProcessEnv) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const config = join(root, ".cache", "wrangler", "config");
  const logs = join(root, ".cache", "wrangler", "logs");
  await Promise.all([mkdir(config, { recursive: true }), mkdir(logs, { recursive: true })]);
  return {
    ...parent,
    WRANGLER_SEND_METRICS: "false",
    XDG_CONFIG_HOME: config,
    WRANGLER_LOG_PATH: logs,
  };
}
