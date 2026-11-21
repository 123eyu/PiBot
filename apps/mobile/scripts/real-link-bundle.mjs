import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export async function bundlePhone(repo, root, ref, name = "mobile") {
  const expoRequire = createRequire(
    await realpath(join(repo, "apps/mobile/node_modules/expo/package.json")),
  );
  const rnRequire = createRequire(expoRequire.resolve("babel-preset-expo/package.json"));
  const babel = rnRequire("@babel/core");
  const rnPreset = rnRequire.resolve("@react-native/babel-preset");
  const outfile = join(root, `${name}.mjs`);
  await build({
    stdin: {
      contents: [
        'export { MobileRuntime } from "./src/runtime/runtime.ts";',
        'export { MobileStorage } from "./src/storage/state.ts";',
        'export { memoryBlobFiles } from "./src/storage/file-cache.ts";',
        'export { createMobileLink } from "./src/transport/real-link.ts";',
        'export { openLocalData, secretData } from "./src/storage/native.ts";',
        'export { ProbeWebSocket, configureNative, configureStorage, emitNative, disposeProbeGlobals } from "./scripts/real-link-native.mjs";',
      ].join("\n"),
      resolveDir: join(repo, "apps/mobile"),
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["react-native", "import"],
    format: "esm",
    target: "es2022",
    inject: [fileURLToPath(new URL("./real-link-native.mjs", import.meta.url))],
    // RN is not Node. Do not let a dependency silently use Node's encoding or Buffer APIs.
    define: { Buffer: "undefined", TextEncoder: "undefined", TextDecoder: "undefined" },
    plugins: [
      {
        name: "phone-source-and-native-boundary",
        setup(builder) {
          const shim = fileURLToPath(new URL("./real-link-native.mjs", import.meta.url));
          builder.onResolve({ filter: /^expo-(secure-store|sqlite)$/ }, (args) => ({
            path: args.path,
            namespace: "storage",
          }));
          builder.onLoad({ filter: /.*/, namespace: "storage" }, (args) => ({
            contents:
              args.path === "expo-sqlite"
                ? `export { openProbeDatabase as openDatabaseAsync } from ${JSON.stringify(shim)};`
                : `import { secureNative } from ${JSON.stringify(shim)}; export const { getItemAsync, setItemAsync, deleteItemAsync, WHEN_UNLOCKED_THIS_DEVICE_ONLY } = secureNative;`,
            loader: "js",
            resolveDir: repo,
          }));
          builder.onResolve(
            {
              filter:
                /(?:NativeWebSocketModule|EventEmitter\/NativeEventEmitter|Utilities\/Platform|Blob\/BlobManager|Blob\/Blob)$/,
            },
            (args) => ({ path: args.path.split("/").at(-1), namespace: "native" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "native" }, (args) => ({
            contents:
              args.path === "NativeWebSocketModule"
                ? `export { socketNative as default } from ${JSON.stringify(shim)};`
                : args.path === "NativeEventEmitter"
                  ? `export { ProbeEmitter as default } from ${JSON.stringify(shim)};`
                  : args.path === "Platform"
                    ? 'export default { OS: "android" };'
                    : args.path === "BlobManager"
                      ? "export default { isAvailable: false };"
                      : "export default class Blob {}",
            loader: "js",
            resolveDir: repo,
          }));
          builder.onResolve({ filter: /featureflags\/ReactNativeFeatureFlags$/ }, () => ({
            path: "flags",
            namespace: "probe",
          }));
          builder.onResolve({ filter: /(?:^|\/)rtc-peer\.ts$/ }, () => ({
            path: "rtc",
            namespace: "probe",
          }));
          // The VPN hint (network-hint.ts) reads Expo's network state and the Android module;
          // both are native, so the probe phone reports "no VPN" like an iPhone would.
          builder.onResolve({ filter: /^expo-network$/ }, () => ({
            path: "network",
            namespace: "probe",
          }));
          builder.onResolve({ filter: /modules\/pibot-android\/index\.ts$/ }, () => ({
            path: "android",
            namespace: "probe",
          }));
          const stubs = {
            flags: "export function enableNativeEventTargetEventDispatching() { return true; }",
            network: [
              'export const NetworkStateType = { NONE: "NONE", UNKNOWN: "UNKNOWN", CELLULAR: "CELLULAR", WIFI: "WIFI", VPN: "VPN" };',
              'export async function getNetworkStateAsync() { return { type: "UNKNOWN", isConnected: true, isInternetReachable: true }; }',
              'export async function getIpAddressAsync() { return "0.0.0.0"; }',
              "export function addNetworkStateListener() { return { remove() {} }; }",
            ].join("\n"),
            android: "export const pibotAndroid = null;",
            rtc: 'export function createNativeMobileRtcPeer() { throw new Error("rtc_unavailable"); }',
          };
          builder.onLoad({ filter: /.*/, namespace: "probe" }, (args) => ({
            contents: stubs[args.path],
            loader: "js",
          }));
          builder.onLoad({ filter: /\/react-native\/.*\.js$/ }, async (args) => ({
            contents: (
              await babel.transformAsync(await readFile(args.path, "utf8"), {
                filename: args.path,
                babelrc: false,
                configFile: false,
                presets: [
                  [rnPreset, { disableImportExportTransform: true, enableBabelRuntime: false }],
                ],
              })
            ).code,
            loader: "js",
            resolveDir: dirname(args.path),
          }));
          // A file the ref has but the working tree no longer has (renamed or removed since).
          if (ref)
            builder.onResolve({ filter: /^\.\.?\// }, (args) => {
              const path = join(args.resolveDir, args.path);
              const name = relative(repo, path).replaceAll("\\", "/");
              if (existsSync(path)) return;
              if (!name.startsWith("apps/mobile/src/") && !name.startsWith("packages/link/src/"))
                return;
              try {
                execFileSync("git", ["cat-file", "-e", `${ref}:${name}`], { cwd: repo });
              } catch {
                return;
              }
              return { path };
            });
          if (ref)
            builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, (args) => {
              const path = relative(repo, args.path).replaceAll("\\", "/");
              if (!path.startsWith("apps/mobile/src/") && !path.startsWith("packages/link/src/"))
                return;
              return {
                contents: execFileSync("git", ["show", `${ref}:${path}`], {
                  cwd: repo,
                  encoding: "utf8",
                }),
                loader: path.endsWith(".ts") ? "ts" : "js",
                resolveDir: dirname(args.path),
              };
            });
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href);
}
