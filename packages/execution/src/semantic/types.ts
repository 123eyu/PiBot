export interface SemanticFile {
  path: string;
  text: string;
  hash: string;
}
/**
 * Run-owned reuse of one file's bytes. The stat fields are the change detector: an entry
 * that still matches the current inode, size and timestamps has the same text and hash.
 */
export interface SemanticFileCacheEntry {
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  text: string;
  hash: string;
}
export interface SemanticFileCache {
  files: Map<string, SemanticFileCacheEntry>;
  /** Total text bytes retained; optional so an external cache can omit accounting. */
  bytes?: number;
}
export interface SemanticSnapshot {
  root: string;
  identity: { device: string; inode: string };
  authorization: string;
  files: SemanticFile[];
  hash: string;
  reasons: string[];
}
export interface SemanticQuery {
  operation:
    | "definition"
    | "references"
    | "diagnostics"
    | "symbol"
    | "outline"
    | "callers"
    | "callees"
    | "implementations";
  /** Only a project-wide symbol search may omit the path; every other operation is file-scoped. */
  path?: string;
  /**
   * A name, never source text: `symbol` searches it, the position-shaped operations resolve it to
   * one declaration inside `path` instead of using `line` / `column`.
   */
  query?: string;
  line?: number;
  column?: number;
  limit?: number;
  /** Automatic diagnostics use an explicitly authorized tsconfig, never a nearer jsconfig. */
  configPath?: string;
  fileOnly?: boolean;
}
export interface SourceAccess {
  root: string;
  authorization: string;
  rootIdentities?: { canonicalPath: string; device: string | null; inode: string | null }[];
  authorize(path: string, kind: "directory" | "file", signal: AbortSignal): Promise<boolean>;
  assertCurrent(signal: AbortSignal): void;
  signal: AbortSignal;
  /** Optional cache owned by the caller's run; every read still authorizes and verifies access. */
  cache?: SemanticFileCache;
}
