import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import table from "./grammars.json" with { type: "json" };
import type { CodeMapAssets } from "./types.ts";

interface GrammarTable {
  languages: {
    id: string;
    package: string;
    wasm: string;
    tags: string[];
    localTags?: string[];
    extensions: string[];
  }[];
}

const LANGUAGES = (table as GrammarTable).languages;
/** Bare extensions select candidates; shared C/C++ headers also need authorized content facts. */
const byExtension = new Map<string, string>();
for (const language of LANGUAGES)
  for (const extension of language.extensions)
    byExtension.set(extension.toLowerCase(), language.id);

export const codeMapLanguages: readonly string[] = LANGUAGES.map((language) => language.id);

export function codeMapLanguageForPath(
  path: string,
  facts?: { text?: string; hasCppSibling?: boolean },
): string | undefined {
  const extension = extname(path).toLowerCase();
  if (
    extension === ".h" &&
    (facts?.hasCppSibling || /\b(?:class|namespace|template)\b|::/.test(facts?.text ?? ""))
  )
    return "cpp";
  return extension ? byExtension.get(extension) : undefined;
}

/**
 * Packaged apps carry only `<id>.wasm` and `<id>.tags.scm` beside the resources, while
 * source runs and servers read the same files from the grammar packages' own installs.
 */
export function codeMapAssets(resourcesDir?: string): CodeMapAssets {
  if (resourcesDir) {
    const dir = join(resourcesDir, "wasm", "codemap");
    return {
      core: join(resourcesDir, "wasm", "web-tree-sitter.wasm"),
      grammars: Object.fromEntries(
        LANGUAGES.map((language) => [
          language.id,
          { wasm: join(dir, `${language.id}.wasm`), tags: [join(dir, `${language.id}.tags.scm`)] },
        ]),
      ),
    };
  }
  const require = createRequire(import.meta.url);
  return {
    core: require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
    grammars: Object.fromEntries(
      LANGUAGES.map((language) => [
        language.id,
        {
          wasm: require.resolve(`${language.package}/${language.wasm}`),
          // TypeScript's tags query only adds TS syntax; the JavaScript one covers the shared part.
          tags: [
            ...language.tags.map((file) => require.resolve(file)),
            ...(language.localTags ?? []).map((file) =>
              fileURLToPath(new URL(file, import.meta.url)),
            ),
          ],
        },
      ]),
    ),
  };
}
