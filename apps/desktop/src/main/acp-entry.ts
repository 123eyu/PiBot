import { homedir } from "node:os";
import { acpAttachError, attachAcp } from "@pibot/sdk/node";
import { resolveDataDir } from "@pibot/storage/data-dir";
import { bundleIdentity } from "../shared/bundle-identity.ts";

/** Loaded before GUI/background setup; this process owns only the stdio/socket pipe. */
export async function startAcpEntry(options: {
  env: Readonly<NodeJS.ProcessEnv>;
  dev: boolean;
  version: string;
  entry: string;
}): Promise<number> {
  const stop = new AbortController();
  let exitCode = 0;
  const interrupt = () => {
    exitCode = 130;
    stop.abort();
  };
  const terminate = () => {
    exitCode = 143;
    stop.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("attach_unsupported_platform");
    await attachAcp({
      dataDir: resolveDataDir({
        platform: process.platform,
        env: options.env,
        homedir: homedir(),
        dev: options.dev,
      }),
      version: `${options.version}:${await bundleIdentity(options.entry, options.version)}`,
      platform: process.platform,
      input: process.stdin,
      output: process.stdout,
      signal: stop.signal,
    });
    return exitCode;
  } catch (error) {
    if (stop.signal.aborted && acpAttachError(error) !== "acp_cleanup_unconfirmed") return exitCode;
    const code = acpAttachError(error);
    const hint =
      code === "app_not_running"
        ? " (open Pi Bot first, or use pibot acp --data for standalone mode)"
        : "";
    process.stderr.write(`pibot acp: ${code}${hint}\n`);
    return 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
