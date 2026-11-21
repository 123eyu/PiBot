// Proves an entry meant for the phone (Metro / Hermes) reaches no Node builtin. Bundles it
// with esbuild under React Native resolution (react-native → browser → module conditions), records
// every import that resolves to a Node builtin with the chain that pulled it in, and prints the
// size of what the phone would carry. Exit 1 when a builtin is reachable.
// Usage: node tools/dev/portable-graph.ts <entry.ts> [--metafile out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { build, type Metafile, type Plugin } from "esbuild";

const [entryArg, ...rest] = process.argv.slice(2);
if (!entryArg) throw new Error("usage: portable-graph.ts <entry> [--metafile out.json]");
const metaOut = rest[0] === "--metafile" ? rest[1] : undefined;
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

// The same pi-ai → phone stand-in swap apps/mobile/metro.config.cjs applies.
const { portableShimFor } = createRequire(import.meta.url)(
  "../../packages/agent/src/portable/metro-shims.cjs",
) as { portableShimFor: (file: string) => string | undefined };
const swapped = new Set<string>();
const phoneShims: Plugin = {
  name: "phone-shims",
  setup(b) {
    b.onLoad({ filter: /@earendil-works.pi-ai.dist./ }, (args) => {
      const shim = portableShimFor(args.path);
      if (!shim) return undefined;
      swapped.add(relative(process.cwd(), args.path));
      return { contents: readFileSync(shim, "utf8"), loader: "ts", resolveDir: dirname(shim) };
    });
  },
};

const hits: { path: string; importer: string }[] = [];
const recordBuiltins: Plugin = {
  name: "record-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      // `fs/promises` is in builtinModules itself; `node:fs/x` style subpaths match by prefix.
      if (!builtins.has(args.path) && !builtins.has(args.path.split("/")[0] ?? ""))
        return undefined;
      hits.push({ path: args.path, importer: relative(process.cwd(), args.importer) });
      return { path: args.path, external: true };
    });
  },
};

const result = await build({
  entryPoints: [resolve(entryArg)],
  bundle: true,
  write: false,
  minify: true,
  format: "esm",
  // "browser" makes esbuild honour package.json `browser` file maps the way Metro does for its
  // react-native/browser main fields (the Anthropic SDK swaps its Node credential helpers there).
  platform: "browser",
  target: "es2022",
  conditions: ["react-native", "browser", "import", "default"],
  mainFields: ["react-native", "browser", "module", "main"],
  plugins: [recordBuiltins, phoneShims],
  metafile: true,
  logLevel: "silent",
});
const meta: Metafile = result.metafile;
if (metaOut) writeFileSync(metaOut, JSON.stringify(meta));

// Walk importer links back to the entry so a hit names the chain to cut.
const importers = new Map<string, string[]>();
for (const [file, input] of Object.entries(meta.inputs))
  for (const imp of input.imports)
    if (!imp.external) importers.set(imp.path, [...(importers.get(imp.path) ?? []), file]);
function chain(file: string): string[] {
  const out = [file];
  const seen = new Set(out);
  let cur = file;
  for (;;) {
    const next = (importers.get(cur) ?? []).find((f) => !seen.has(f));
    if (!next) return out;
    out.push(next);
    seen.add(next);
    cur = next;
  }
}

// Metro rejects `import(expr)` / `require(expr)` with a non-literal argument at transform time
// (esbuild only warns), so list them too. Swapped files are not bundled and are skipped.
const nonLiteral: { file: string; call: string }[] = [];
for (const file of Object.keys(meta.inputs)) {
  if (swapped.has(file) || !/\.[cm]?[jt]sx?$/u.test(file)) continue;
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/(?<![\w.$])(import|require)\(\s*(?!["'`)])([^)\n]{0,40})/gu))
    nonLiteral.push({ file, call: `${m[1]}(${m[2]}` });
}

const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
const byPackage = new Map<string, number>();
for (const [file, input] of Object.entries(meta.inputs)) {
  const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/u.exec(file);
  const key = m?.[1] ?? "(workspace)";
  byPackage.set(key, (byPackage.get(key) ?? 0) + input.bytes);
}
console.log(
  JSON.stringify(
    {
      entry: entryArg,
      inputs: Object.keys(meta.inputs).length,
      phoneShims: [...swapped],
      minifiedBytes: bytes,
      inputBytesByPackage: Object.fromEntries([...byPackage].sort((a, b) => b[1] - a[1])),
      nodeBuiltins: hits.map((h) => ({ import: h.path, chain: chain(h.importer).slice(0, 8) })),
      nonLiteralDynamicImports: nonLiteral,
    },
    null,
    1,
  ),
);
if (hits.length || nonLiteral.length) process.exitCode = 1;
