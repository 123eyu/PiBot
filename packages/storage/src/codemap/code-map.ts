import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/database.ts";

export interface CodeMapRoot {
  /** sha256(device:inode:canonicalPath): a folder replaced in place is a different root. */
  key: string;
  path: string;
  device: string;
  inode: string;
  /** Target extractor; individual files may still carry an older fingerprint during a rebuild. */
  extractorFingerprint: string;
}

export interface CodeMapFileState {
  path: string;
  language: string | null;
  size: number;
  mtimeNs: string;
  hash: string;
  /** NULL on legacy rows; only a successful whole-file replacement advances this value. */
  extractorFingerprint: string | null;
  /** A `.h` beside a `.cpp`: grammar choice depends on it even when the header bytes match. */
  hasCppSibling?: boolean;
}

export interface CodeMapSymbolRow {
  name: string;
  kind: string;
  definition: boolean;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CodeMapWriteInput {
  root: CodeMapRoot;
  indexedAt: string;
  /**
   * Changed content, extractor or grammar selection: symbols and fingerprint replace the whole
   * prior file version, even when a header's bytes match.
   */
  changed: readonly { file: CodeMapFileState; symbols: readonly CodeMapSymbolRow[] }[];
  /** Same hash and grammar: refresh stat and neighbour facts for later fast paths. */
  touched: readonly { path: string; size: number; mtimeNs: string; hasCppSibling?: boolean }[];
  /** Complete retention set; omit for a progress checkpoint that must not prune other files. */
  keep?: readonly string[];
}

/** A name hit joined with the version of the file it came from. */
export interface CodeMapSymbolHit extends CodeMapSymbolRow {
  path: string;
  hash: string;
}

/** One definition for the ranked map, with how often its name is referenced in the whole root. */
export interface CodeMapEntryRow extends CodeMapSymbolRow {
  path: string;
  hash: string;
  language: string | null;
  /** References are counted across the root, not per file: the ranking must not favour big files. */
  references: number;
  /** Map relevance only; raw reference counts remain unchanged for display. */
  score: number;
}

/**
 * A path scope that is either one file or a folder prefix. LIKE metacharacters in a real path
 * (`_`, `%`, `\`) are escaped, so a folder named `a_b` cannot also match `axb`.
 */
function scoped(prefix: string | undefined): { sql: string; params: string[] } {
  if (!prefix) return { sql: "", params: [] };
  const escaped = prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
  return {
    sql: " AND (s.path = ? OR s.path LIKE ? ESCAPE '\\')",
    params: [prefix, `${escaped}/%`],
  };
}

const FILE_COLUMNS =
  "path, language, size, mtime_ns AS mtimeNs, hash, extractor_fingerprint AS extractorFingerprint, has_cpp_sibling AS hasCppSibling";

export class CodeMapRepo {
  constructor(private readonly db: DatabaseSync) {}

  extractorFingerprint(rootKey: string): string | null | undefined {
    const row = this.db
      .prepare("SELECT extractor_fingerprint AS fingerprint FROM code_roots WHERE root_key = ?")
      .get(rootKey) as { fingerprint: string | null } | undefined;
    return row?.fingerprint;
  }

  /** The stored root rows; a move or a replaced inode shows up as an extra key, not a mismatch. */
  roots(): { key: string; path: string }[] {
    return this.db.prepare("SELECT root_key AS key, root_path AS path FROM code_roots").all() as {
      key: string;
      path: string;
    }[];
  }

  files(rootKey: string): Map<string, CodeMapFileState> {
    const rows = this.db
      .prepare(`SELECT ${FILE_COLUMNS} FROM code_files WHERE root_key = ?`)
      .all(rootKey) as unknown as CodeMapFileState[];
    return new Map(
      rows.map((row) => [row.path, { ...row, hasCppSibling: Boolean(row.hasCppSibling) }]),
    );
  }

  counts(rootKey: string): { files: number; symbols: number } {
    const files = this.db
      .prepare("SELECT COUNT(*) AS n FROM code_files WHERE root_key = ?")
      .get(rootKey) as { n: number };
    const symbols = this.db
      .prepare("SELECT COUNT(*) AS n FROM code_symbols WHERE root_key = ?")
      .get(rootKey) as { n: number };
    return { files: Number(files.n), symbols: Number(symbols.n) };
  }

  /**
   * Each checkpoint atomically replaces complete file versions. Only a completed walk supplies
   * `keep`: a partial parser batch must never prune the files it has not reached yet.
   */
  write(input: CodeMapWriteInput): { removed: number; symbols: number } {
    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO code_roots(root_key, root_path, device, inode, indexed_at, extractor_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(root_key) DO UPDATE SET
             root_path = excluded.root_path,
             device = excluded.device,
             inode = excluded.inode,
             indexed_at = excluded.indexed_at,
             extractor_fingerprint = excluded.extractor_fingerprint`,
        )
        .run(
          input.root.key,
          input.root.path,
          input.root.device,
          input.root.inode,
          input.indexedAt,
          input.root.extractorFingerprint,
        );
      const placeholders = input.keep?.map(() => "?").join(",");
      const removed = input.keep
        ? Number(
            this.db
              .prepare(
                placeholders
                  ? `DELETE FROM code_files WHERE root_key = ? AND path NOT IN (${placeholders})`
                  : "DELETE FROM code_files WHERE root_key = ?",
              )
              .run(input.root.key, ...input.keep).changes,
          )
        : 0;
      const upsert = this.db.prepare(
        `INSERT INTO code_files(root_key, path, language, size, mtime_ns, hash, indexed_at, extractor_fingerprint, has_cpp_sibling)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_key, path) DO UPDATE SET
           language = excluded.language,
           size = excluded.size,
           mtime_ns = excluded.mtime_ns,
           hash = excluded.hash,
           indexed_at = excluded.indexed_at,
           extractor_fingerprint = excluded.extractor_fingerprint,
           has_cpp_sibling = excluded.has_cpp_sibling`,
      );
      const touch = this.db.prepare(
        "UPDATE code_files SET size = ?, mtime_ns = ?, indexed_at = ?, has_cpp_sibling = ? WHERE root_key = ? AND path = ?",
      );
      for (const row of input.touched)
        touch.run(
          row.size,
          row.mtimeNs,
          input.indexedAt,
          row.hasCppSibling ? 1 : 0,
          input.root.key,
          row.path,
        );
      const clear = this.db.prepare("DELETE FROM code_symbols WHERE root_key = ? AND path = ?");
      const insert = this.db.prepare(
        `INSERT INTO code_symbols(
           root_key, path, hash, language, name, kind, definition,
           start_line, start_column, end_line, end_column
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let symbols = 0;
      for (const { file, symbols: rows } of input.changed) {
        upsert.run(
          input.root.key,
          file.path,
          file.language,
          file.size,
          file.mtimeNs,
          file.hash,
          input.indexedAt,
          file.extractorFingerprint,
          file.hasCppSibling ? 1 : 0,
        );
        clear.run(input.root.key, file.path);
        for (const row of rows) {
          insert.run(
            input.root.key,
            file.path,
            file.hash,
            file.language ?? "unknown",
            row.name,
            row.kind,
            row.definition ? 1 : 0,
            row.startLine,
            row.startColumn,
            row.endLine,
            row.endColumn,
          );
          symbols++;
        }
      }
      return { removed, symbols };
    });
  }

  /** Symbols recorded for one file version; the outline tool reads through here. */
  symbols(rootKey: string, path: string): CodeMapSymbolRow[] {
    const rows = this.db
      .prepare(
        `SELECT name, kind, definition, start_line AS startLine, start_column AS startColumn,
                end_line AS endLine, end_column AS endColumn
         FROM code_symbols WHERE root_key = ? AND path = ? 
         ORDER BY start_line, start_column, name`,
      )
      .all(rootKey, path) as (Omit<CodeMapSymbolRow, "definition"> & { definition: number })[];
    return rows.map((row) => ({ ...row, definition: row.definition === 1 }));
  }

  /**
   * Exact-name lookup for `code_symbols`. Tags only record spellings, so this never fuzzes
   * the name; definitions come first because they are what a reader is usually after.
   */
  search(
    rootKey: string,
    name: string,
    options: { prefix?: string; limit: number },
  ): CodeMapSymbolHit[] {
    const scope = scoped(options.prefix);
    const rows = this.db
      .prepare(
        `SELECT s.path, f.hash, s.name, s.kind, s.definition, s.start_line AS startLine,
                s.start_column AS startColumn, s.end_line AS endLine, s.end_column AS endColumn
         FROM code_symbols s
         JOIN code_files f ON f.root_key = s.root_key AND f.path = s.path
         WHERE s.root_key = ? AND s.name = ?${scope.sql}
         ORDER BY s.definition DESC, s.path, s.start_line, s.start_column
         LIMIT ?`,
      )
      .all(rootKey, name, ...scope.params, options.limit) as (Omit<
      CodeMapSymbolHit,
      "definition"
    > & { definition: number })[];
    return rows.map((row) => ({ ...row, definition: row.definition === 1 }));
  }

  /**
   * Count names once, then discount ambiguous/common spellings and supporting code before LIMIT.
   * Otherwise test declarations can fill the candidate window before the map sees source files.
   */
  entries(rootKey: string, options: { prefix?: string; limit: number }): CodeMapEntryRow[] {
    const scope = scoped(options.prefix);
    const rows = this.db
      .prepare(
        `WITH names AS (
           SELECT name, SUM(definition = 0) AS refs, SUM(definition = 1) AS declarations
           FROM code_symbols WHERE root_key = ? GROUP BY name
         ), ranked AS (
           SELECT s.path, f.hash, f.language, s.name, s.kind, s.start_line AS startLine,
                  s.start_column AS startColumn, s.end_line AS endLine, s.end_column AS endColumn,
                  n.refs,
                  (1.0 + n.refs / (1.0 + n.declarations)) *
                  CASE WHEN length(s.name) <= 3 THEN 0.15
                       WHEN lower(s.name) IN ('equals', 'delay', 'setup', 'teardown', 'tostring',
                                              'constructor', 'initialize') THEN 0.2 ELSE 1 END *
                  CASE WHEN lower('/' || s.path) GLOB '*/test/*'
                         OR lower('/' || s.path) GLOB '*/tests/*'
                         OR lower('/' || s.path) GLOB '*/__tests__/*'
                         OR lower('/' || s.path) GLOB '*/test-*/*'
                         OR lower('/' || s.path) GLOB '*/example/*'
                         OR lower('/' || s.path) GLOB '*/examples/*'
                         OR lower('/' || s.path) GLOB '*/sample/*'
                         OR lower('/' || s.path) GLOB '*/samples/*'
                         OR lower('/' || s.path) GLOB '*/spec/*'
                         OR lower(s.path) GLOB '*.test.*'
                         OR lower(s.path) GLOB '*.spec.*'
                         OR lower(s.path) GLOB '*test.java'
                         OR lower(s.path) GLOB '*_test.go'
                         OR lower(s.path) GLOB '*/test_*.rb'
                       THEN 0.05 ELSE 1 END AS score
           FROM code_symbols s
           JOIN code_files f ON f.root_key = s.root_key AND f.path = s.path
           JOIN names n ON n.name = s.name
           WHERE s.root_key = ? AND s.definition = 1${scope.sql}
         )
         SELECT * FROM ranked ORDER BY score DESC, path, startLine, startColumn LIMIT ?`,
      )
      .all(rootKey, rootKey, ...scope.params, options.limit) as (Omit<
      CodeMapEntryRow,
      "definition" | "references"
    > & { refs: number })[];
    return rows.map((row) => ({
      ...row,
      definition: true,
      references: Number(row.refs),
    }));
  }

  forget(rootKey: string): number {
    return transaction(this.db, () =>
      Number(this.db.prepare("DELETE FROM code_roots WHERE root_key = ?").run(rootKey).changes),
    );
  }

  /**
   * Cleanup after the folder is unbound: the canonical path is what the caller still knows once
   * the directory itself is gone, so the index is dropped by path rather than by a re-stat.
   */
  forgetPath(path: string): number {
    return transaction(this.db, () => {
      const keys = this.db
        .prepare("SELECT root_key AS key FROM code_roots WHERE root_path = ?")
        .all(path) as { key: string }[];
      let removed = 0;
      for (const { key } of keys)
        removed += Number(
          this.db.prepare("DELETE FROM code_roots WHERE root_key = ?").run(key).changes,
        );
      return removed;
    });
  }
}
