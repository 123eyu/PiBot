import { readFile } from "node:fs/promises";
import { Language, Parser, Query } from "web-tree-sitter";
import { collectSymbols } from "./symbols.ts";
import type { CodeMapAssets, CodeMapWorkerFile, CodeMapWorkerResponse } from "./types.ts";

/** Bounds on what one batch may return; `code_map` summarises files, it never needs every call. */
const MAX_SYMBOLS_TOTAL = 50_000;

interface LoadedGrammar {
  language: Language;
  query: Query;
}

/**
 * One grammar load per language per batch: loading a WASM grammar and compiling its query costs
 * far more than parsing a small file, so a 500-file batch must not repeat it.
 */
function grammarLoader(assets: CodeMapAssets, cancelled: () => boolean) {
  const loaded = new Map<string, Promise<LoadedGrammar>>();
  // The WASM runtime must be located before any grammar loads; packaged apps ship it beside them.
  const ready = Parser.init({ locateFile: () => assets.core });
  return {
    ready,
    async load(id: string): Promise<LoadedGrammar> {
      const existing = loaded.get(id);
      if (existing) return existing;
      const files = assets.grammars[id];
      if (!files) throw new Error("codemap_grammar_unknown");
      const pending = (async () => {
        await ready;
        const language = await Language.load(files.wasm);
        const sources = await Promise.all(files.tags.map((file) => readFile(file, "utf8")));
        if (cancelled()) throw new Error("codemap_cancelled");
        return { language, query: new Query(language, sources.join("\n")) };
      })();
      loaded.set(id, pending);
      return pending;
    },
    async dispose() {
      for (const result of await Promise.allSettled(loaded.values())) {
        if (result.status !== "fulfilled") continue;
        result.value.query.delete();
      }
    },
  };
}

export async function extractCodeMap(
  files: CodeMapWorkerFile[],
  assets: CodeMapAssets,
  cancelled: () => boolean,
): Promise<CodeMapWorkerResponse> {
  // A worker owns its parser, so no query state leaks between files of the batch.
  const grammars = grammarLoader(assets, cancelled);
  // Every Parser instance requires the WASM runtime to be initialized first.
  await grammars.ready;
  if (cancelled()) throw new Error("codemap_cancelled");
  const parser = new Parser();
  const results: CodeMapWorkerResponse["files"] = [];
  const reasons: string[] = [];
  let total = 0;
  try {
    for (const file of files) {
      if (cancelled()) throw new Error("codemap_cancelled");
      if (total >= MAX_SYMBOLS_TOTAL) {
        // The batch stops here; the remaining files stay unreported so the caller keeps no hash for
        // a version nobody parsed (it gets its turn on the next refresh).
        reasons.push("symbol_limit");
        break;
      }
      // A grammar that is missing or whose query does not compile fails the same way for every file
      // of that language, so that file is reported as unparsed and the batch continues.
      let grammar: LoadedGrammar;
      try {
        grammar = await grammars.load(file.language);
      } catch (error) {
        if (error instanceof Error && error.message === "codemap_cancelled") throw error;
        reasons.push(`grammar_unavailable:${file.language}`);
        continue;
      }
      let collected: ReturnType<typeof collectSymbols>;
      // PHP treats a BOM before <?php as inline text. Strip it only for parsing; source hashes and
      // previews retain the original bytes, and first-line columns below include the removed unit.
      const hasBom = file.text.startsWith("\uFEFF");
      try {
        parser.setLanguage(grammar.language);
        const tree = parser.parse(hasBom ? file.text.slice(1) : file.text);
        if (!tree) throw new Error("codemap_parse_failed");
        try {
          collected = collectSymbols(grammar.query.matches(tree.rootNode), cancelled);
        } finally {
          tree.delete();
        }
      } catch (error) {
        // A grammar can reject a pathological file; the rest of the batch is still useful.
        if (error instanceof Error && error.message === "codemap_cancelled") throw error;
        reasons.push(`parse_failed:${file.path}`);
        continue;
      }
      if (collected.definitionsTruncated) reasons.push(`definition_limit:${file.path}`);
      if (collected.referencesTruncated) reasons.push(`reference_limit:${file.path}`);
      if (hasBom) {
        // Name ranges and the outline's declaration ranges both count the stripped unit.
        for (const range of collected.symbols.flatMap((symbol) =>
          symbol.declarationRange ? [symbol, symbol.declarationRange] : [symbol],
        )) {
          if (range.startLine === 1) range.startColumn++;
          if (range.endLine === 1) range.endColumn++;
        }
      }
      // Do not stamp an incomplete file as parsed: the next refresh must get another chance.
      if (total + collected.symbols.length > MAX_SYMBOLS_TOTAL) {
        reasons.push("symbol_limit");
        break;
      }
      const symbols = collected.symbols;
      total += symbols.length;
      results.push({ path: file.path, symbols });
    }
    return { files: results, reasons };
  } finally {
    parser.delete();
    await grammars.dispose();
  }
}
