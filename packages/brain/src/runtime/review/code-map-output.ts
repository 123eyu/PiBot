import { SemanticError } from "@pibot/execution/semantic";
import { type CodeMapResult, CodeMapResultSchema } from "@pibot/protocol-base";
import type { CodeMapEntryRow } from "@pibot/storage";

const MAX_FILES = 200;
const MAX_SYMBOLS_PER_FILE = 5;
type MapFile = CodeMapResult["files"][number];

/** Relevance is separate from raw references: many generic declarations must not win by addition. */
function rankedFiles(rows: readonly CodeMapEntryRow[]) {
  const grouped = new Map<string, { file: MapFile; score: number }>();
  for (const row of rows) {
    let entry = grouped.get(row.path);
    if (!entry) {
      entry = {
        file: {
          path: row.path,
          hash: row.hash,
          language: row.language,
          references: 0,
          symbols: [],
        },
        score: row.score,
      };
      grouped.set(row.path, entry);
    }
    entry.score = Math.max(entry.score, row.score);
    entry.file.references += row.references;
    if (entry.file.symbols.length >= MAX_SYMBOLS_PER_FILE) continue;
    entry.file.symbols.push({
      name: row.name,
      kind: row.kind || "unknown",
      line: row.startLine,
      range: {
        line: row.startLine,
        column: row.startColumn,
        endLine: row.endLine,
        endColumn: row.endColumn,
      },
    });
  }
  return [...grouped.values()].sort(
    (a, b) =>
      b.score - a.score || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0),
  );
}

/**
 * Budget the exact redacted wire JSON, including metadata and the estimate itself. A character
 * estimate is deliberately not a model tokenizer; it must at least measure the text we send.
 */
export function codeMapOutput(
  rows: readonly CodeMapEntryRow[],
  metadata: Omit<CodeMapResult, "files" | "estimatedTokens">,
  serialize: (result: CodeMapResult) => string,
): { result: CodeMapResult; text: string } {
  const result: CodeMapResult = { ...metadata, estimatedTokens: 0, files: [] };
  const encode = () => {
    let text = serialize(result);
    while (result.estimatedTokens !== Math.ceil(text.length / 4)) {
      result.estimatedTokens = Math.ceil(text.length / 4);
      text = serialize(result);
    }
    return text;
  };
  // Reserve the extra character in `false` if packing ends up covering every candidate.
  const fits = () => encode().length + (result.truncated ? 1 : 0) <= metadata.maxTokens * 4;
  while (!fits() && result.reasons.length) {
    result.reasons.pop();
    result.truncated = true;
  }
  // A very long scope alone can exceed the smallest budget; never silently exceed it.
  if (!fits()) throw new SemanticError("too_large");
  const ranked = rankedFiles(rows);
  const selected: { source: MapFile; output: MapFile }[] = [];
  // Spread the first pass across files before spending the remainder on detail in any one file.
  for (const { file } of ranked) {
    if (selected.length >= MAX_FILES) break;
    const output = { ...file, symbols: file.symbols.slice(0, 1) };
    result.files.push(output);
    if (fits()) selected.push({ source: file, output });
    else result.files.pop();
  }
  for (let depth = 1; depth < MAX_SYMBOLS_PER_FILE; depth++) {
    for (const { source, output } of selected) {
      const symbol = source.symbols[depth];
      if (!symbol) continue;
      output.symbols.push(symbol);
      if (!fits()) output.symbols.pop();
    }
  }
  result.truncated ||=
    result.files.reduce((sum, file) => sum + file.symbols.length, 0) < rows.length;
  // Key order and field shapes are fixed by the shared contract, regardless of the repository.
  const parsed = CodeMapResultSchema.parse(result);
  Object.assign(result, parsed);
  return { result, text: encode() };
}
