import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { testDataDirectory } from "./data.ts";
import { fail } from "./process.ts";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { data: { type: "string" } },
  });
  const sql = positionals.join(" ").trim();
  // Small accepted language; SQLite readOnly/query_only is the actual write barrier, including CTEs.
  if (
    !/^(SELECT|WITH|EXPLAIN\s+(?:QUERY\s+PLAN\s+)?SELECT)\b/i.test(sql) ||
    /;\s*\S/.test(sql) ||
    /\b(load_extension|attach|detach|pragma)\b/i.test(sql)
  )
    throw new Error("Only a single read-only SELECT/WITH/EXPLAIN SELECT query is allowed.");
  const dir = await testDataDirectory(values.data);
  const db = new DatabaseSync(join(dir, "pibot.db"), { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const statement = db.prepare(sql);
    const rows = [];
    for (const row of statement.iterate()) {
      rows.push(row);
      if (rows.length >= 1000) break;
    }
    console.log(
      JSON.stringify(
        rows,
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ),
    );
  } finally {
    db.close();
  }
} catch (error) {
  fail(error);
}
