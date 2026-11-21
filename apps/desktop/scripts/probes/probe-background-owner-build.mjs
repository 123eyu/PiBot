// Existing esbuild only; no production dependency or code hook is added.
import { createRequire } from "node:module";

const probeRequire = createRequire(import.meta.url);
const { build } = createRequire(probeRequire.resolve("vite/package.json"))("esbuild");

import { resolve } from "node:path";

await build({
  entryPoints: ["scripts/probe-background-owner-child.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  loader: { ".css": "text" },
  outfile: "node_modules/.cache/probe-background-owner-child.mjs",
  define: { __PIBOT_DEV_BUILD__: "true" },
  alias: {
    electron: "./scripts/probe-background-owner-electron.ts",
    "@pibot/agent": "../../packages/agent/src/core/env.ts",
  },
  external: ["@earendil-works/*", "@anthropic-ai/*"],
  banner: {
    js: 'import { createRequire as probeRequireFactory } from "node:module"; const require = probeRequireFactory(import.meta.url);',
  },
  plugins: [
    {
      name: "private-owner-post-spawn-failure",
      setup(builder) {
        builder.onResolve({ filter: /^@pibot\/routines\/host\/dev$/ }, (args) => {
          if (args.importer.endsWith("/background-owner.ts"))
            return { path: resolve("scripts/probe-background-owner-dev.ts") };
        });
      },
    },
  ],
});
await build({
  entryPoints: ["scripts/probe-background-utility.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "node_modules/.cache/probe-background-utility.mjs",
});
