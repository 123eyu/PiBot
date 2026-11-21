// Typechecks tool projects that only exist with the private development repository checked out;
// a public checkout skips them instead of failing on a missing tsconfig.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// typescript's exports map hides bin/tsc; locate it from the package's main entry instead.
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript")), "..", "bin", "tsc");
for (const config of process.argv.slice(2)) {
  if (!existsSync(config)) continue;
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", config], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
