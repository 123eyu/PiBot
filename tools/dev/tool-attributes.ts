// Every registered tool declares what a call does (permission category, whether it leaves
// a file, what the person receives). The lists that used to repeat those names by hand — write
// deliveries, audit rows, permission categories — now read the declarations, so a tool added without
// one would silently drop out of them (office_template_fill and office_convert were missing
// from WRITE_FILE_TOOLS). This runs in `pnpm lint`, not as a unit test: it is a repository rule about
// a static registration, not behaviour.
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const desktop = createRequire(join(root, "apps/desktop/package.json"));
const vite = createRequire(desktop.resolve("vite/package.json"));
const { createJiti } = vite("jiti") as {
  createJiti(
    base: string | URL,
    options: { fsCache: boolean },
  ): { import(path: string): Promise<unknown> };
};
const loader = createJiti(import.meta.url, { fsCache: false });
const load = async (path: string) => loader.import(join(root, path));

const { createToolDefinitions } = (await load("packages/brain/src/runtime/tools/tools.ts")) as {
  createToolDefinitions(registry: unknown): readonly { name: string }[];
};
const { capabilityToolSpecs, capabilityToolGroups } = (await load(
  "packages/protocol/src/aggregate/tools.ts",
)) as {
  capabilityToolSpecs: Record<
    string,
    { attributes?: { readOnly?: boolean }; policy: { category: string; readOnly?: boolean } }
  >;
  capabilityToolGroups: unknown;
};
const { KERNEL_TOOL_ATTRIBUTES } = (await load(
  "packages/protocol-base/src/tools/tool-attributes.ts",
)) as { KERNEL_TOOL_ATTRIBUTES: Record<string, unknown> };

// Names that stay declared although no schema registers them today: a retired tool keeps its old
// category for an older client, and an alias may return. They are allowed, just not required.
const RETIRED = new Set(["project_notes", "browser_submit", "image_generation"]);

const registered = createToolDefinitions({
  specs: capabilityToolSpecs,
  groups: capabilityToolGroups,
}).map((tool) => tool.name);
const issues: string[] = [];
for (const name of registered) {
  const spec = capabilityToolSpecs[name];
  if (spec) {
    if (!spec.attributes)
      issues.push(`${name}: capability 工具没有声明 attributes / no attributes declared`);
    // Two declarations of the same fact drift; the list that reads readOnly must agree with policy.
    const declared = spec.attributes?.readOnly;
    const policy = spec.policy.readOnly;
    if (declared !== undefined && policy !== undefined && declared !== policy)
      issues.push(
        `${name}: attributes.readOnly=${declared} 与 policy.readOnly=${policy} 不一致 / disagrees with policy`,
      );
    continue;
  }
  if (!Object.hasOwn(KERNEL_TOOL_ATTRIBUTES, name))
    issues.push(`${name}: 内核工具没有声明属性 / kernel tool has no attributes`);
}
for (const name of Object.keys(KERNEL_TOOL_ATTRIBUTES)) {
  if (!registered.includes(name) && !RETIRED.has(name))
    issues.push(`${name}: 属性存在但工具未注册 / attributes declared for an unregistered tool`);
}

if (issues.length) {
  console.error(
    ["工具属性声明不完整 / tool attribute declarations incomplete:", ...issues].join("\n"),
  );
  process.exitCode = 1;
} else {
  const declared = registered.filter((name) => !capabilityToolSpecs[name]).length;
  console.log(
    `工具属性检查通过：${declared} 个内核工具、${Object.keys(capabilityToolSpecs).length} 个能力工具都声明了属性`,
  );
}
