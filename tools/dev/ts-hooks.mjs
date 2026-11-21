// Probe-only loader: workspace sources use TypeScript parameter properties, which Node's
// strip-only mode rejects. Transpile .ts with the esbuild already present in the pnpm store.
// Use: node --import ./tools/dev/ts-hooks.mjs <script>.ts
import { readdirSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const store = join(fileURLToPath(new URL("../../node_modules/.pnpm", import.meta.url)));
const dir = readdirSync(store).find((name) => /^esbuild@/.test(name));
if (!dir) throw new Error("esbuild not found in node_modules/.pnpm; run pnpm install first");
const esbuild = createRequire(join(store, dir, "node_modules", "esbuild", "package.json"))(
  "esbuild",
);

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts") || url.includes("/node_modules/"))
      return nextLoad(url, context);
    const result = nextLoad(url, { ...context, format: "module" });
    const source = String(result.source);
    const { code } = esbuild.transformSync(source, {
      loader: "ts",
      format: "esm",
      target: "node22",
      sourcefile: fileURLToPath(url),
    });
    return { format: "module", source: code, shortCircuit: true };
  },
});
