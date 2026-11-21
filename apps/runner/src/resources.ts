import { dirname, join } from "node:path";
import { isSea } from "node:sea";

/** The outer entry owns the installed layout; execution stays usable by desktop and plain Node. */
export function runnerResources() {
  return isSea()
    ? {
        resourcesDir: join(dirname(process.execPath), "resources"),
        helperArgs: {
          sandbox: ["--pibot-internal", "sandbox-host"],
          violations: ["--pibot-internal", "violation-log"],
        },
      }
    : {};
}
