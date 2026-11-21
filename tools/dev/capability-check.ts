import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const desktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const vite = createRequire(desktop.resolve("vite/package.json"));
const { createJiti } = vite("jiti") as {
  createJiti(
    base: string | URL,
    options: { fsCache: boolean },
  ): {
    import(path: string): Promise<unknown>;
  };
};
const loader = createJiti(import.meta.url, { fsCache: false });
const { CAPABILITIES, GENERAL_TOOLS } = (await loader.import(
  "../../packages/protocol-base/src/tools/capabilities.ts",
)) as {
  CAPABILITIES: readonly { id: string; builtinTools: readonly string[] }[];
  GENERAL_TOOLS: readonly string[];
};
const { createToolDefinitions } = (await loader.import(
  "../../packages/brain/src/runtime/tools/tools.ts",
)) as {
  createToolDefinitions(registry: unknown): readonly { name: string }[];
};
const { capabilityToolSpecs, capabilityToolGroups } = (await loader.import(
  "../../packages/protocol/src/aggregate/tools.ts",
)) as { capabilityToolSpecs: unknown; capabilityToolGroups: unknown };
const toolDefinitions = createToolDefinitions({
  specs: capabilityToolSpecs,
  groups: capabilityToolGroups,
});

const definitions = toolDefinitions.map((tool) => tool.name);
const defined = new Set(definitions);
const owners = new Map<string, string[]>();
const claim = (tool: string, owner: string) =>
  owners.set(tool, [...(owners.get(tool) ?? []), owner]);

for (const capability of CAPABILITIES)
  for (const tool of capability.builtinTools) claim(tool, capability.id);
for (const tool of GENERAL_TOOLS) claim(tool, "GENERAL_TOOLS");

const issues: string[] = [];
for (const name of defined) {
  const claims = owners.get(name) ?? [];
  if (claims.length !== 1)
    issues.push(
      claims.length === 0 ? `未登记工具：${name}` : `重复登记工具：${name} (${claims.join(", ")})`,
    );
}
for (const [name, claims] of owners) {
  if (!defined.has(name)) issues.push(`登记了不存在的工具：${name} (${claims.join(", ")})`);
}
for (const name of defined) {
  if (definitions.filter((value) => value === name).length > 1)
    issues.push(`工具声明重复：${name}`);
}

const catalogPath = new URL(
  "../../packages/brain/src/runtime/tools/tool-catalog.ts",
  import.meta.url,
);
const catalogSource = await readFile(catalogPath, "utf8");
const catalogNames = new Set<string>();
// Kernel groups use literal arrays. Capability groups are composed from capabilityToolSpecs and
// are already covered by toolDefinitions above.
for (const tools of catalogSource.matchAll(/tools:\s*\[([\s\S]*?)\]/g))
  for (const name of (tools[1] ?? "").matchAll(/"([a-z][a-z0-9_]*)"/g))
    if (name[1]) catalogNames.add(name[1]);
for (const name of catalogNames)
  if (!defined.has(name)) issues.push(`tool-catalog 引用了不存在的工具：${name}`);

if (issues.length) {
  console.error(["能力工具登记检查失败：", ...issues.map((issue) => `- ${issue}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`能力工具登记完整：${definitions.length} 个工具，各有且仅有一个归属`);
}
