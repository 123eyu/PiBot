import { join } from "node:path";
import { createCuaLoader } from "@pibot/computer";
import type { EmbeddedCuaDriverHostLike, EmbeddedDriverConnection } from "@trycua/cua-driver";
import { app, systemPreferences } from "electron";
import { createMacCuaOwner } from "./mac-cua-owner.ts";

/** Imported only in the Electron owner, after whenReady; never in GUI or brain. */
export function createMacCuaRuntime(options: {
  invalidate(): void;
  release(): Promise<void>;
  failed(code: string, error: unknown): void;
}) {
  const loader = createCuaLoader();
  let host: EmbeddedCuaDriverHostLike | undefined;
  const getHost = async () => {
    if (host) return host;
    const sdk = await loader.load();
    // Development uses the same pinned, prepared resource; never the system PATH or open.
    const binary = app.isPackaged
      ? join(process.resourcesPath, "cua-driver")
      : join(app.getAppPath(), "out/native-resources", `mac-${process.arch}`, "cua-driver");
    host = sdk.EmbeddedCuaDriverHost.withOptions(
      sdk.EmbeddedDriverHostOptions.new({
        binaryPath: binary,
        hostBundleId: "app.pibot.desktop",
        startupTimeoutMs: 15_000n,
        shutdownTimeoutMs: 15_000n,
        permissionMode: sdk.EmbeddedPermissionMode.Standard,
        approveSessionPolicy: false,
        dangerouslyBypassApprovals: false,
        // The SDK only forwards an allowlist (telemetry / update switches below) and clears the
        // rest of the environment; any other name, e.g. CUA_DRIVER_DISABLE_RUN_SCRIPT, makes
        // withOptions throw Configuration and the daemon never starts. run_script stays out of
        // reach through the client whitelist (CUA_TOOL_WHITELIST).
        environment: [
          { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" },
          { name: "CUA_TELEMETRY_ENABLED", value: "false" },
          { name: "CUA_DRIVER_RS_UPDATE_CHECK", value: "false" },
        ],
        inheritStderr: false,
        noOverlay: true,
      }),
    );
    return host;
  };
  const owner = createMacCuaOwner<EmbeddedDriverConnection>({
    ...options,
    async permissions() {
      if (!app.isReady()) throw new Error("cua_owner_before_ready");
      // Polled every 2 s. The SDK's requestMacOSPermissions shows the system prompt on each call,
      // so an untrusted app (e.g. after a reinstall changed its signature) was prompted endlessly;
      // these checks never prompt, and the settings pages are opened from the UI instead.
      const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
      const screenRecording = systemPreferences.getMediaAccessStatus("screen") === "granted";
      return { accessibility, screenRecording, required: accessibility && screenRecording };
    },
    start: async () => (await getHost()).start(),
    restart: async () => (await getHost()).restart(),
    stop: async () => {
      await host?.stop();
    },
    destroy: () => {
      if (host && "uniffiDestroy" in host && typeof host.uniffiDestroy === "function")
        host.uniffiDestroy();
      host = undefined;
    },
    async watch(connection, exited, signal) {
      await host?.waitForExit(connection.generation, { signal });
      if (!signal.aborted) exited();
    },
  });
  return {
    ...owner,
    get permissions() {
      return owner.permissions;
    },
    async connect(sdk: Awaited<ReturnType<typeof loader.load>>) {
      return sdk.CuaDriver.connect((await owner.connection()).socketPath);
    },
  };
}
