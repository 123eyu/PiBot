// Built-in roles, groups and skills tell the model which tools to call. A name no tool defines makes
// a real model look for a tool that does not exist (office_template_fields was named months
// before the tool shipped), and no other check looks at prose. This runs in `pnpm lint`, not as a
// unit test: it is a repository rule about static text, not behaviour.
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const builtinDir = join(root, "packages/teams/builtin");

// Conditional lines may name a tool that is not in the catalog yet: the skill says to use the
// existing path when the tool is absent. Empty since office_template_fields and
// office_template_fill shipped; the mechanism stays so the next pending name is caught the same way.
const PENDING = new Set<string>();
// Requires the line to be written as a condition (中英), so an allowlisted name cannot become an
// unconditional "call this" instruction that fails on today's build.
const CONDITIONAL = /有 |没有|可用|时 |If |if |When |when |available|otherwise|instead/;
// history.json records past versions of skill text; those names are history, not instructions.
const SKIP = new Set(["history.json"]);

const desktop = createRequire(join(root, "apps/desktop/package.json"));
const vite = createRequire(desktop.resolve("vite/package.json"));
const { createJiti } = vite("jiti") as {
  createJiti(
    base: string | URL,
    options: { fsCache: boolean },
  ): { import(path: string): Promise<unknown> };
};
const loader = createJiti(import.meta.url, { fsCache: false });
const { createToolDefinitions } = (await loader.import(
  "../../packages/brain/src/runtime/tools/tools.ts",
)) as {
  createToolDefinitions(registry: unknown): readonly { name: string }[];
};
const { capabilityToolSpecs, capabilityToolGroups } = (await loader.import(
  "../../packages/protocol/src/aggregate/tools.ts",
)) as { capabilityToolSpecs: unknown; capabilityToolGroups: unknown };
// Permission categories are also written with snake_case (send_out, read_file …); text may name them
// in a permission sentence, so they are vocabulary, not unknown tools.
const { CategorySchema } = (await loader.import(
  "../../packages/protocol-base/src/permissions/settings.ts",
)) as { CategorySchema: { options: readonly string[] } };
const categories = new Set(CategorySchema.options);
const tools = new Set(
  createToolDefinitions({ specs: capabilityToolSpecs, groups: capabilityToolGroups }).map(
    (tool) => tool.name,
  ),
);
// Only names that look like catalog tools are checked: a word is suspect when its prefix is one the
// catalog already uses (office_, memory_, browser_ …), so ordinary prose never trips the rule.
const prefixes = new Set(
  [...tools].flatMap((name) => {
    const at = name.indexOf("_");
    return at > 0 ? [name.slice(0, at)] : [];
  }),
);
const candidate = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (entry.isFile() && !SKIP.has(entry.name)) found.push(path);
  }
  return found;
}

const issues: string[] = [];
for (const path of await files(builtinDir)) {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(candidate)) {
      const name = match[0];
      const prefix = name.slice(0, name.indexOf("_"));
      if (!prefixes.has(prefix) || categories.has(name) || tools.has(name)) continue;
      const where = `${relative(root, path)}:${index + 1}`;
      if (!PENDING.has(name))
        issues.push(`${where}: 工具目录里没有 ${name} / no tool named ${name}`);
      else if (!CONDITIONAL.test(line))
        issues.push(
          `${where}: ${name} 只允许写在条件句里（有…时用，没有时用已有工具）/ ${name} may only appear in a conditional sentence`,
        );
    }
  }
}

if (issues.length) {
  console.error(
    ["内置文本引用了不存在的工具 / built-in text names unknown tools:", ...issues].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(`内置文本工具名检查通过：${tools.size} 个工具，${PENDING.size} 个待实现项按条件写法`);
}
