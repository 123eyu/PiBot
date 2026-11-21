// Long prompts live as Markdown next to the code that uses them (`<dir>/prompts/<name>.md`); this
// turns each file into `<dir>/prompts/<name>.ts`, so the brain still loads plain code at run time
// (headless runner, packaged app and tests never read prompt files from disk).
//
//   node tools/dev/prompts-gen.ts           write every generated module
//   node tools/dev/prompts-gen.ts --check   fail when a module does not match its md file
//
// File format. Text before the first block is notes for readers and is not sent anywhere. Each
// block starts with a heading line of the form  ## `key.path`  and runs to the next one. Leading
// and trailing blank lines of a block are dropped; everything else, including inner blank lines
// and trailing spaces, is the prompt byte for byte. `{{name}}` marks a value the code fills in:
// such a block becomes a function taking `{ name }`. Dotted keys nest: `memoryRule.zh` is read as
// `xPrompts.memoryRule.zh`. Editing a block changes what models see and the cached prompt prefix
// (docs/prompt-cache.md), so keep edits deliberate.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const check = process.argv.includes("--check");
const HEADING = /^## `([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)`\s*$/;
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

type Tree = { [key: string]: Tree | string };

function promptFiles(dir: string, found: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist" || name === "out")
      continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) promptFiles(path, found);
    else if (name.endsWith(".md") && basename(dirname(path)) === "prompts") found.push(path);
  }
  return found;
}

function parse(path: string): Tree {
  const lines = readFileSync(path, "utf8").split("\n");
  const blocks: [string, string[]][] = [];
  for (const line of lines) {
    const key = HEADING.exec(line)?.[1];
    if (key) blocks.push([key, []]);
    else blocks.at(-1)?.[1].push(line);
  }
  if (!blocks.length) throw new Error(`${path}: no prompt blocks`);
  const tree: Tree = {};
  for (const [key, body] of blocks) {
    while (body.length && body[0]?.trim() === "") body.shift();
    while (body.length && body.at(-1)?.trim() === "") body.pop();
    if (!body.length) throw new Error(`${path}: block ${key} is empty`);
    const parts = key.split(".");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      const next = node[part] ?? {};
      if (typeof next === "string") throw new Error(`${path}: ${key} nests under a text block`);
      node[part] = next;
      node = next;
    }
    const leaf = parts.at(-1) as string;
    if (leaf in node) throw new Error(`${path}: duplicate block ${key}`);
    node[leaf] = body.join("\n");
  }
  return tree;
}

const templateText = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

function leaf(text: string) {
  const names = [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string))];
  if (!names.length) return JSON.stringify(text);
  const body = templateText(text).replace(PLACEHOLDER, (_, name: string) => `\${v.${name}}`);
  return `(v: { ${names.map((name) => `${name}: string | number`).join("; ")} }) => \`${body}\``;
}

function emit(tree: Tree, indent: string): string {
  return Object.entries(tree)
    .map(
      ([key, value]) =>
        `${indent}${key}: ${typeof value === "string" ? leaf(value) : `{\n${emit(value, `${indent}  `)}${indent}}`},\n`,
    )
    .join("");
}

const camel = (name: string) => name.replace(/[-_.]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const biome = join(
  repo,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);

function generate(md: string) {
  const target = md.replace(/\.md$/, ".ts");
  const source = `// Generated from ${basename(md)} by tools/dev/prompts-gen.ts. Edit the md file, then run \`pnpm gen:prompts\`.\nexport const ${camel(basename(md, ".md"))}Prompts = {\n${emit(parse(md), "  ")}} as const;\n`;
  const formatted = execFileSync(biome, ["format", `--stdin-file-path=${target}`], {
    input: source,
    encoding: "utf8",
    cwd: repo,
  });
  return { target, formatted };
}

let stale = 0;
const files = [...promptFiles(join(repo, "packages")), ...promptFiles(join(repo, "apps"))];
for (const md of files) {
  const { target, formatted } = generate(md);
  let current: string | undefined;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = undefined;
  }
  if (current === formatted) continue;
  if (check) {
    stale++;
    console.error(`${relative(repo, target)} does not match ${basename(md)}; run pnpm gen:prompts`);
  } else {
    writeFileSync(target, formatted);
    console.log(`wrote ${relative(repo, target)}`);
  }
}
if (stale) process.exit(1);
if (!check) console.log(`prompts: ${files.length} md files`);
