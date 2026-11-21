import { readFileSync, writeFileSync } from "node:fs";

const source = new URL("../src/theme/tokens.css", import.meta.url);
const destination = new URL("../src/theme/tokens.ts", import.meta.url);
const themes = { light: new Map<string, string>(), dark: new Map<string, string>() };
const css = readFileSync(source, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
if (css.replace(blockPattern, "").trim()) throw new Error("Unsupported token stylesheet structure");

// This is intentionally the small grammar used by tokens.css; new selectors must be reviewed,
// rather than silently generating an incomplete mobile palette.
for (const block of css.matchAll(blockPattern)) {
  const selectors = block[1]?.trim().split(/\s*,\s*/) ?? [];
  const declarations = [...(block[2] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
  if ([...(block[2] ?? "").matchAll(/--[\w-]+\s*:/g)].length !== declarations.length)
    throw new Error("Unsupported token declaration");
  if (!declarations.length) continue;
  for (const selector of selectors) {
    const targets =
      selector === ":root"
        ? [themes.light, themes.dark]
        : selector === ':root[data-theme="light"]'
          ? [themes.light]
          : selector === '[data-theme="dark"]'
            ? [themes.dark]
            : undefined;
    if (!targets) throw new Error(`Unsupported token selector: ${selector}`);
    for (const values of targets)
      for (const [, name, value] of declarations)
        if (name && value) values.set(name.slice(2), value.trim().replace(/\s+/g, " "));
  }
}

function resolveTokens(values: Map<string, string>) {
  const resolved = new Map<string, string>();
  function resolve(name: string, visiting = new Set<string>()): string {
    const cached = resolved.get(name);
    if (cached !== undefined) return cached;
    const value = values.get(name);
    if (value === undefined || visiting.has(name))
      throw new Error(`Invalid token reference: ${name}`);
    const path = new Set(visiting).add(name);
    const result = value.replace(/var\(\s*--([\w-]+)\s*\)/g, (_, reference: string) =>
      resolve(reference, path),
    );
    if (/var\(/.test(result)) throw new Error(`Unsupported token value: ${name}`);
    resolved.set(name, result);
    return result;
  }
  if (!values.size) throw new Error("Empty theme");
  return Object.fromEntries([...values.keys()].sort().map((key) => [key, resolve(key)]));
}

const data = { light: resolveTokens(themes.light), dark: resolveTokens(themes.dark) };
if (JSON.stringify(Object.keys(data.light)) !== JSON.stringify(Object.keys(data.dark)))
  throw new Error("Theme token names differ");
// JSON is valid TypeScript too. One format for generation and checking avoids a formatter dependency.
const output = `// Generated from tokens.css by scripts/generate-tokens.ts; do not edit.\n// biome-ignore-all format: This file is checked byte-for-byte by the generator.\nexport const tokens = ${JSON.stringify(data, null, 2)} as const;\n\nexport type ThemeTokens = (typeof tokens)[keyof typeof tokens];\n`;
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check"))
  throw new Error("Usage: node packages/ui/scripts/generate-tokens.ts [--check]");
if (arguments_[0] === "--check") {
  if (readFileSync(destination, "utf8") !== output)
    throw new Error("Theme tokens are stale; run pnpm --filter @pibot/ui tokens:generate");
} else writeFileSync(destination, output);
