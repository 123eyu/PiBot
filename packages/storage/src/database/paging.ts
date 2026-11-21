import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type Page, PageSchema } from "@pibot/protocol-base";

type Filter = readonly [column: string, value: SQLInputValue];

/** SQL identifiers come only from repo literals; external values always bind as parameters. */
export function readPage(
  db: DatabaseSync,
  table: string,
  columns: string,
  timeColumn: string,
  page: Page,
  filters: Filter[] = [],
  cursorFilters: Filter[] = filters,
): Record<string, unknown>[] {
  const { before, limit = 50 } = PageSchema.parse(page);
  const predicates = filters.map(([column]) => `${column} IS ?`);
  const values = filters.map(([, value]) => value);
  if (before !== undefined) {
    const cursor = db
      .prepare(`SELECT ${timeColumn} AS at, id FROM ${table} WHERE id = ?`)
      .get(before);
    if (!cursor) return [];
    // Scope checks survive revocation/resolution of the last item in a displayed page.
    const cursorPredicates = cursorFilters.map(([column]) => `${column} IS ?`);
    const matching = db
      .prepare(
        `SELECT id FROM ${table} WHERE id = ?${
          cursorPredicates.length ? ` AND ${cursorPredicates.join(" AND ")}` : ""
        }`,
      )
      .get(before, ...cursorFilters.map(([, value]) => value));
    if (!matching) return [];
    predicates.push(`(${timeColumn} < ? OR (${timeColumn} = ? AND id < ?))`);
    values.push(String(cursor.at), String(cursor.at), String(cursor.id));
  }
  return db
    .prepare(
      `SELECT ${columns} FROM ${table}${
        predicates.length ? ` WHERE ${predicates.join(" AND ")}` : ""
      } ORDER BY ${timeColumn} DESC, id DESC LIMIT ?`,
    )
    .all(...values, limit);
}

export function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
