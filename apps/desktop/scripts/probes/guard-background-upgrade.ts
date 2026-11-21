import { resolve } from "node:path";
import { drainBackgroundForUpgrade } from "../../src/main/background/background-upgrade.ts";

const [dataDir, expectedVersion, observedGuiPids] = process.argv.slice(2);
if (!dataDir || !expectedVersion || !observedGuiPids)
  throw new Error("Usage: guard-background-upgrade DATA_DIR EXPECTED_BUILD GUI_PIDS_OR_none");
const guiPids = observedGuiPids === "none" ? [] : observedGuiPids.split(",").map(Number);
await drainBackgroundForUpgrade({ dataDir: resolve(dataDir), expectedVersion, guiPids });
console.log(
  "Background and observed GUI PIDs exited; consistent backup and replacement may proceed.",
);
