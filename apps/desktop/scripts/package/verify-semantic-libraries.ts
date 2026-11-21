import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFile } from "@electron/asar";
import { STANDARD_LIBRARIES } from "../../../../packages/execution/src/semantic/libraries.ts";

/**
 * The semantic worker (code_navigate, post-edit diagnostics) reads TypeScript's standard library
 * files by hash. electron-builder drops `*.d.ts` from node_modules, so packaged apps had none and
 * every query failed with ENOENT; the build now copies them to
 * out/main/typescript-lib. Check they are in the archive and unchanged.
 */
export function verifySemanticLibraries(archive: string, files: readonly string[]) {
  const present = new Set(files);
  for (const [name, sha256] of Object.entries(STANDARD_LIBRARIES)) {
    const path = `out/main/typescript-lib/${name}.txt`;
    assert(present.has(`/${path}`), `Missing TypeScript library: ${name}`);
    assert.equal(
      createHash("sha256").update(extractFile(archive, path)).digest("hex"),
      sha256,
      `TypeScript library changed: ${name}`,
    );
  }
}

/** Code map: every language in the shared table ships a valid grammar and its tags query. */
export function verifyCodeMapGrammars(dir: string) {
  const table = JSON.parse(
    readFileSync(
      new URL("../../../../packages/execution/src/codemap/grammars.json", import.meta.url),
      "utf8",
    ),
  ) as { languages: { id: string }[] };
  for (const { id } of table.languages) {
    assert(
      WebAssembly.validate(readFileSync(join(dir, `${id}.wasm`))),
      `Invalid code map grammar: ${id}`,
    );
    assert(existsSync(join(dir, `${id}.tags.scm`)), `Missing code map tags query: ${id}`);
  }
}
