import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const local = (path) => fileURLToPath(new URL(path, import.meta.url));
// --settings drives the phone's settings calls through the desktop's real phone gateway
// into a real brain on a temporary data directory; it runs under the probe TypeScript loader.
// --notify checks the notification decisions, push/local de-duplication and the unlock
// gate against the desktop's real push sender; same loader, no network.
// --phone-data runs the Bot's phone tools and share-to-Pi-Bot against a real brain with
// the remote capability over the in-memory link, the phone side being the app's own handler.
// --records runs the phone's run-records sync, log pages and chat targets through the
// desktop's real phone gateway (allowlist, 3-day window, page caps) on an in-memory wire.
for (const [flag, script] of [
  ["--settings", "./settings-probe.mjs"],
  ["--notify", "./notify-probe.mjs"],
  ["--phone-data", "./phone-data-probe.mjs"],
  ["--records", "./records-probe.mjs"],
  // --compose: composer attachments online, offline-queued and refused, plus restrictions.
  ["--compose", "./compose-probe.mjs"],
  // --offline: the phone's offline replies, sync and import against a real brain.
  ["--offline", "./offline-probe.mjs"],
]) {
  if (!process.argv.includes(flag)) continue;
  const result = spawnSync(
    process.execPath,
    ["--import", local("../../../tools/dev/ts-hooks.mjs"), local(script)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
const mode = process.argv.includes("--relay")
  ? "relay"
  : process.argv.includes("--controls")
    ? "controls"
    : process.argv.includes("--files")
      ? "files"
      : "memory";
// --controls checks the chat controls against the desktop's real phone gate (remote allowlist).
// Only this dev probe joins the two packages; the app itself never imports desktop code.
const controlsEntry = `import { runControlsScenario } from ${JSON.stringify(local("../src/dev/controls-scenario.ts"))};
import { isPhoneMethod, restrictPhoneParams } from ${JSON.stringify(local("../../../packages/remote/src/brain/rpc/allowlist.ts"))};
export const run = () => runControlsScenario({ isPhoneMethod, restrictPhoneParams });`;
// --files runs through the same gate plus the desktop's preview slicer.
const filesEntry = `import { runFilesScenario } from ${JSON.stringify(local("../src/dev/files-scenario.ts"))};
import { isPhoneMethod, restrictPhoneParams } from ${JSON.stringify(local("../../../packages/remote/src/brain/rpc/allowlist.ts"))};
import { previewChunks } from ${JSON.stringify(local("../../../packages/remote/src/brain/rpc/preview-chunks.ts"))};
export const run = () => runFilesScenario({ isPhoneMethod, restrictPhoneParams }, previewChunks);`;
const directory = await mkdtemp(join(tmpdir(), "pibot-mobile-probe-"));
try {
  const outfile = join(directory, "scenario.mjs");
  await build({
    ...(mode === "controls" || mode === "files"
      ? {
          stdin: {
            contents: mode === "files" ? filesEntry : controlsEntry,
            resolveDir: dirname(local("../package.json")),
            sourcefile: "controls-entry.ts",
            loader: "ts",
          },
        }
      : {
          entryPoints: [
            local(mode === "relay" ? "../src/dev/relay-scenario.mjs" : "../src/dev/scenario.ts"),
          ],
        }),
    outfile,
    bundle: true,
    // RTC is lazy and unused by these Node scenarios; its React Native runtime is native-only.
    external: ["react-native-webrtc"],
    platform: "node",
    format: "esm",
    target: "node26",
    logLevel: "silent",
    plugins: [
      {
        name: "lazy-native-rtc",
        setup(builder) {
          // Preserve the dynamic boundary: bundling its native import would eagerly load RN.
          builder.onResolve({ filter: /(?:^|\/)rtc-peer\.ts$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path),
            external: true,
          }));
          // The VPN hint (network-hint.ts) reads Expo's network state and the Android module;
          // both load React Native, so the Node scenarios report "no VPN" instead.
          builder.onResolve(
            { filter: /^expo-network$|modules\/pibot-android\/index\.ts$/ },
            (args) => ({
              path: args.path.startsWith("expo-network") ? "network" : "android",
              namespace: "native-stub",
            }),
          );
          builder.onLoad({ filter: /.*/, namespace: "native-stub" }, (args) => ({
            contents:
              args.path === "network"
                ? [
                    'export const NetworkStateType = { NONE: "NONE", UNKNOWN: "UNKNOWN", CELLULAR: "CELLULAR", WIFI: "WIFI", VPN: "VPN" };',
                    'export async function getNetworkStateAsync() { return { type: "UNKNOWN", isConnected: true }; }',
                    'export async function getIpAddressAsync() { return "0.0.0.0"; }',
                    "export function addNetworkStateListener() { return { remove() {} }; }",
                  ].join("\n")
                : "export const pibotAndroid = null;",
            loader: "js",
          }));
        },
      },
      ...(mode === "relay"
        ? [
            {
              name: "local-runtime-paths",
              setup(builder) {
                // Keep the existing Node harness in place: it resolves Worker/config paths via import.meta.url.
                builder.onResolve(
                  { filter: /tools\/probes\/remote\/(local-runtime|live-socket)\.ts$/ },
                  (args) => ({ path: resolve(args.resolveDir, args.path), external: true }),
                );
              },
            },
          ]
        : []),
    ],
  });
  const scenario = await import(pathToFileURL(outfile).href);
  const result =
    mode === "relay"
      ? await scenario.runRelayScenario()
      : mode === "controls" || mode === "files"
        ? await scenario.run()
        : await scenario.runScenario();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
