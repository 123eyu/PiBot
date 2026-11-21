import { ExecError } from "../core/types.ts";
import type { GitObjectObservation } from "./git-config-object-view.ts";
import { type OutputScanBudget, outputScanBatch } from "./git-output-scan.ts";
import { gitResourceIdentity, readGitResource, sameGitIdentity } from "./git-resource-identity.ts";

/** Recheck every observation for every phase; this is not an authorization cache. */
export async function verifyOutputSources(
  sources: readonly (GitObjectObservation & { hash?: string })[],
  signal: AbortSignal,
  budget: OutputScanBudget,
) {
  for (let offset = 0; offset < sources.length; offset += 8) {
    await outputScanBatch(sources.slice(offset, offset + 8), budget, async (source) => {
      const identity = await budget.read(() => gitResourceIdentity(source.path));
      if (!sameGitIdentity(source.identity, identity)) throw new ExecError("authorization_changed");
      if (source.hash) {
        const read = await budget.read(() =>
          readGitResource(source.path, 16 * 1024 * 1024, signal),
        );
        if (read.hash !== source.hash) throw new ExecError("authorization_changed");
      }
    });
  }
  budget.check();
}
