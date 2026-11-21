import { resolve } from "node:path";
import { readSource, type SourceAccess } from "@pibot/execution/semantic";

/** Internal-only version receipt: symbols never enter a model-visible JSON tool result. */
export const diagnosticVersions = Symbol("diagnosticVersions");
export async function diagnosticsStillCurrent(
  access: SourceAccess,
  versions: ReadonlyMap<string, string>,
) {
  for (const [path, hash] of versions) {
    let source: Awaited<ReturnType<typeof readSource>>;
    try {
      source = await readSource(access, resolve(access.root, path));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if ((source?.hash ?? "missing") !== hash) return false;
  }
  return true;
}
