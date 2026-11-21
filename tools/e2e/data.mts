import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Observe only the disposable application's committed state, never open its writer/repositories. */
export class Data {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  rows(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue>[] {
    assert(/^SELECT\s/i.test(sql) && !sql.includes(";"), "e2e_read_query_required");
    const db = new DatabaseSync(join(this.directory, "pibot.db"), { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  }
  one(sql: string, ...params: SQLInputValue[]) {
    return this.rows(sql, ...params)[0];
  }
}
