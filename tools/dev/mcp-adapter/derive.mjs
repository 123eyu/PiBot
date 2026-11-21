// Copies the pinned pi-mcp-adapter snapshot into packages/agent/src/mcp/adapter for derivation.
// Vendor snapshot under tools/vendor/pi-mcp-adapter is the immutable source of truth; this script
// only bootstraps a new destination. Never overwrite the reviewed Pi Bot adaptations.
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const files = [
  "abort.ts",
  "tool-parameters.ts",
  "json-schema-validator.ts",
  "types.ts",
  "utils.ts",
  "runtime-owner.ts",
  "tool-registrar.ts",
  "mcp-output-guard.ts",
  "tool-metadata.ts",
  "search-ranking.ts",
  "host-managed.ts",
];

const header = (name) => `// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: <state what changed in this file>.
// Upstream file: ${name}
`;

const target = resolve("packages/agent/src/mcp/adapter");
for (const name of files) {
  const exists = await lstat(join(target, name)).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (exists) throw new Error("Adapter destination exists; preserve the reviewed adaptations");
}
for (const name of files) {
  const source = await readFile(join("tools/vendor/pi-mcp-adapter", `${name}.txt`), "utf8");
  await writeFile(join(target, name), `${header(name)}${source}`, { flag: "wx" });
  console.log(`derived ${name}`);
}
