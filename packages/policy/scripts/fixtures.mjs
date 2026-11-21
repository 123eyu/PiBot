import { registerHooks } from "node:module";
import { transformSync } from "esbuild";

// Node 26 strips types but rejects the protocol's parameter properties. Preserve source URLs for WASM resolution.
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith(".ts") || !loaded.source) return loaded;
    return {
      ...loaded,
      format: "module",
      source: transformSync(String(loaded.source), {
        loader: "ts",
        format: "esm",
        target: "es2023",
      }).code,
    };
  },
});
const { printFixtures } = await import("../test/fixtures/index.ts");
const resourcesDir = process.argv.find((arg) => arg.startsWith("--resources-dir="))?.slice(16);
process.exitCode = (await printFixtures(resourcesDir)) ? 1 : 0;
