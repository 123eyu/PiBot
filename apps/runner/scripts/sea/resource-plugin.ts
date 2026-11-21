import type { Plugin } from "esbuild";

export function runnerResourcesPlugin(main: boolean): Plugin {
  return {
    name: "runner-resources",
    setup(api) {
      api.onResolve(
        {
          filter: /^(?:@anthropic-ai\/sandbox-runtime|node-datachannel|@napi-rs\/keyring)(?:\/|$)/,
        },
        (args) => {
          // SRT's JS subpaths expose schemas and path-protection helpers, not native bindings.
          // Bundle them normally; only the root runtime needs its on-disk vendor layout.
          if (args.path.startsWith("@anthropic-ai/sandbox-runtime/")) return undefined;
          return main || args.path === "@napi-rs/keyring"
            ? { path: args.path, namespace: "runner-native" }
            : { path: args.path, external: true };
        },
      );
      api.onLoad({ filter: /.*/, namespace: "runner-native" }, (args) => {
        const names =
          args.path === "node-datachannel"
            ? ["PeerConnection", "cleanup", "initLogger"]
            : args.path === "@napi-rs/keyring"
              ? ["AsyncEntry"]
              : ["SandboxManager"];
        return {
          contents:
            'import {createRequire} from "node:module"; import {dirname,join} from "node:path"; const value=createRequire(join(dirname(process.execPath),"resources","package.json"))(' +
            (args.path === "@napi-rs/keyring"
              ? '"@napi-rs/keyring-"+process.platform+"-"+process.arch+(process.platform==="linux"?"-gnu":process.platform==="win32"?"-msvc":"")'
              : JSON.stringify(args.path)) +
            "); export default value;" +
            names.map((name) => `export const ${name}=value.${name};`).join(""),
          loader: "js",
        };
      });
    },
  };
}
