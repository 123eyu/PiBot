/**
 * The worker only ever receives text the caller already read through authorization; it
 * must not touch the filesystem, so limits are enforced on this side of the boundary too.
 */
export interface CodeMapInputFile {
  path: string;
  text: string;
  /** Supplied by the authorized directory walk; workers never inspect project directories. */
  hasCppSibling?: boolean;
}
/** One tags name: the capture suffix as its kind and the name node's 1-based range. */
export interface CodeMapSymbol {
  name: string;
  /** The `@definition.*` / `@reference.*` suffix, e.g. `function`, `class`, `call`. */
  kind: string;
  definition: boolean;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** Transient outline nesting from full declaration nodes, while ranges locate names. */
  depth?: number;
  /** Only outlines consume the full declaration extent; the index keeps name coordinates. */
  declarationRange?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}
export interface CodeMapFileResult {
  path: string;
  /** null when no grammar covers the extension. */
  language: string | null;
  /**
   * Absent when the parser never reported this file (a missing grammar, a parse failure, or the
   * batch's symbol cap stopping first). `hash` and `symbols` come together on purpose: a stored
   * hash means "this version was parsed", so recording one for an unparsed file would leave it
   * permanently stale.
   */
  hash?: string;
  symbols?: CodeMapSymbol[];
}
export interface CodeMapResult {
  engine: "tree-sitter";
  /** Tags queries match syntax, not types: results may contain false positives and misses. */
  approximate: true;
  files: CodeMapFileResult[];
  /** Short codes (`unsupported_language:<path>`, `file_too_large:<path>`, `file_limit`, ...). */
  reasons: string[];
}
export interface CodeMapAssets {
  /** `web-tree-sitter.wasm`, shared by every grammar. */
  core: string;
  grammars: Record<string, { wasm: string; tags: string[] }>;
}
export interface CodeMapWorkerFile {
  path: string;
  language: string;
  text: string;
}
export interface CodeMapWorkerRequest {
  files: CodeMapWorkerFile[];
  assets: CodeMapAssets;
  cancel: SharedArrayBuffer;
}
export interface CodeMapWorkerResponse {
  files: { path: string; symbols: CodeMapSymbol[] }[];
  reasons: string[];
}
