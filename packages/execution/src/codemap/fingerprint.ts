import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { codeMapAssets } from "./grammars.ts";

/** Bump when extraction semantics change without changing queries (ranges, caps, language choice). */
// 2: name-node ranges, separate definition/reference caps, `.h` grammar choice.
export const CODE_MAP_EXTRACTOR_VERSION = 2;

/** Only trusted shipped queries participate; source and packaged concatenations hash identically. */
export async function codeMapExtractorFingerprint(
  resourcesDir?: string,
  signal: AbortSignal = AbortSignal.timeout(15_000),
): Promise<string> {
  signal.throwIfAborted();
  const assets = codeMapAssets(resourcesDir);
  const queries = await Promise.all(
    // codeMapAssets constructs this object in grammars.json order in both layouts.
    Object.entries(assets.grammars).map(async ([id, grammar]) => {
      const texts = await Promise.all(
        grammar.tags.map((path) => readFile(path, { encoding: "utf8", signal })),
      );
      return [id, texts.join("\n")];
    }),
  );
  signal.throwIfAborted();
  return createHash("sha256")
    .update(JSON.stringify([CODE_MAP_EXTRACTOR_VERSION, queries]))
    .digest("hex");
}
