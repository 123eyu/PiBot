import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { acpAttachError, attachAcp } from "@pibot/sdk/node";
import { resolveDataDir } from "@pibot/storage/data-dir";

/** The development CLI may attach only to the desktop build emitted by this checkout. */
async function localBuildIdentity() {
  try {
    const desktop = new URL("../../desktop/", import.meta.url);
    const manifest: unknown = JSON.parse(await readFile(new URL("package.json", desktop), "utf8"));
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      typeof manifest.version !== "string"
    )
      throw new Error("invalid_version");
    const hash = (
      await readFile(new URL("out/main/startup-bundle.sha256", desktop), "utf8")
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid_hash");
    return `${manifest.version}:${createHash("sha256").update(manifest.version).update(hash).digest("hex")}`;
  } catch {
    throw new Error("version_mismatch");
  }
}

export async function runAcpAttach() {
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
    if (process.platform === "win32") throw new Error("attach_unsupported_platform");
    const version = await localBuildIdentity();
    await attachAcp({
      dataDir: resolveDataDir({
        platform: process.platform,
        env: process.env,
        homedir: homedir(),
        dev: false,
      }),
      version,
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
      code === "version_mismatch"
        ? " (build this checkout first: pnpm build)"
        : code === "app_not_running"
          ? " (open Pi Bot first, or use --data for standalone mode)"
          : "";
    process.stderr.write(`pibot acp: ${code}${hint}\n`);
    return 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
