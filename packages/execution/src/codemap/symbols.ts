import type { QueryMatch } from "web-tree-sitter";
import type { CodeMapSymbol } from "./types.ts";

export const MAX_DEFINITIONS = 2000;
export const MAX_REFERENCES = 2000;
export const MAX_FILE_SYMBOLS = MAX_DEFINITIONS + MAX_REFERENCES;

interface Declaration {
  symbol: CodeMapSymbol;
  start: number;
  end: number;
}

/** Name coordinates serve navigation; declaration extents let outlines bound subsequent reads. */
export function collectSymbols(matches: QueryMatch[], cancelled: () => boolean) {
  const definitions: Declaration[] = [];
  const references: CodeMapSymbol[] = [];
  const seen = new Set<string>();
  let definitionsTruncated = false;
  let referencesTruncated = false;
  for (const match of matches) {
    if (cancelled()) throw new Error("codemap_cancelled");
    const nameNode = match.captures.find((capture) => capture.name === "name")?.node;
    const name = nameNode?.text;
    if (!nameNode || !name || name.length > 200) continue;
    for (const capture of match.captures) {
      const kind = /^(definition|reference)\.(.+)$/.exec(capture.name);
      if (!kind) continue;
      const definition = kind[1] === "definition";
      // Rust's function and method queries overlap: capture kind is not a second declaration.
      const key = `${definition ? "d" : "r"}:${nameNode.startIndex}:${nameNode.endIndex}:${name}`;
      if (seen.has(key)) continue;
      if (
        definition ? definitions.length >= MAX_DEFINITIONS : references.length >= MAX_REFERENCES
      ) {
        if (definition) definitionsTruncated = true;
        else referencesTruncated = true;
        continue;
      }
      seen.add(key);
      const symbol: CodeMapSymbol = {
        name,
        kind: (kind[2] as string).slice(0, 40),
        definition,
        startLine: nameNode.startPosition.row + 1,
        startColumn: nameNode.startPosition.column + 1,
        endLine: nameNode.endPosition.row + 1,
        endColumn: nameNode.endPosition.column + 1,
      };
      if (definition) {
        symbol.declarationRange = {
          startLine: capture.node.startPosition.row + 1,
          startColumn: capture.node.startPosition.column + 1,
          endLine: capture.node.endPosition.row + 1,
          endColumn: capture.node.endPosition.column + 1,
        };
        definitions.push({ symbol, start: capture.node.startIndex, end: capture.node.endIndex });
      } else references.push(symbol);
      break;
    }
  }
  definitions.sort((a, b) => a.start - b.start || b.end - a.end);
  const open: Declaration[] = [];
  for (const declaration of definitions) {
    while (open.length) {
      const parent = open[open.length - 1] as Declaration;
      if (
        parent.start <= declaration.start &&
        parent.end >= declaration.end &&
        (parent.start < declaration.start || parent.end > declaration.end)
      )
        break;
      open.pop();
    }
    declaration.symbol.depth = open.length;
    open.push(declaration);
  }
  // Calls cannot displace declarations, even when they appear first in a large source file.
  return {
    symbols: [...definitions.map(({ symbol }) => symbol), ...references],
    definitionsTruncated,
    referencesTruncated,
  };
}
