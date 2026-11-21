// Runs a tool from the private development repository (Codex tooling, real-model evals, UI
// driver). It shares this working tree but is not part of the public repository, so a public
// checkout gets a clear message instead of a module-not-found stack.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const [entry, ...args] = process.argv.slice(2);
if (!entry || !existsSync(entry)) {
  console.error(
    `${entry ?? "(no tool)"} belongs to the private development repository and is not in this checkout.`,
  );
  process.exit(1);
}
const result = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
