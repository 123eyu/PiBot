import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { dataRoot } from "./data.ts";
import { fail } from "./process.ts";

try {
  const { values } = parseArgs({
    options: { days: { type: "string" }, data: { type: "string" } },
  });
  const days = values.days === undefined ? 14 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new Error("--days 必须是 1–3650 的整数 / --days must be an integer from 1 to 3650");
  const file = join(values.data ? resolve(values.data) : join(dataRoot, "default"), "pibot.db");
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;");
    // A snapshot keeps counts and percentiles consistent while the brain appends more events.
    db.exec("BEGIN");
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const through = new Date().toISOString();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind='tool.result' AND at>=? AND at<=?")
      .get(since, through)?.n;
    console.log(`工具耗时 / Tool performance · ${days} 天 / days · ${count ?? 0} results · ms`);
    console.log(
      "工具 / Tool\t阶段 / Phase\t次数 / Count\t合计 / Total\t平均 / Mean\tP90\t最大 / Max",
    );
    const rows = db.prepare(`
      WITH events AS (
        SELECT CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS p
        FROM run_events WHERE kind='tool.result' AND at>=? AND at<=?
      ), samples AS (
        SELECT COALESCE(json_extract(p,'$.tool'),'unknown_tool') AS tool,
          stage.value AS phase,
          json_extract(p, CASE WHEN stage.value='total' THEN '$.durationMs'
            ELSE '$.phases.' || stage.value END) AS ms
        FROM events CROSS JOIN json_each('["total","policy","approvalWait","queue","exec","post"]') stage
      ), valid AS (
        SELECT tool,phase,ms FROM samples
        WHERE typeof(tool)='text' AND typeof(ms) IN ('integer','real')
          AND ms>=0 AND ms<=9007199254740991
      ), ranked AS (
        SELECT tool,phase,ms,ROW_NUMBER() OVER (PARTITION BY tool,phase ORDER BY ms) AS rank,
          COUNT(*) OVER (PARTITION BY tool,phase) AS n FROM valid
      )
      SELECT tool,phase,COUNT(*) AS count,SUM(ms) AS total,AVG(ms) AS mean,
        MAX(CASE WHEN rank=CAST((n*9+9)/10 AS INTEGER) THEN ms END) AS p90,MAX(ms) AS max
      FROM ranked GROUP BY tool,phase
      ORDER BY tool,CASE phase WHEN 'total' THEN 0 WHEN 'policy' THEN 1 WHEN 'approvalWait' THEN 2
        WHEN 'queue' THEN 3 WHEN 'exec' THEN 4 ELSE 5 END
    `);
    let measured = 0;
    for (const row of rows.iterate(since, through)) {
      const tool = safeTool(row.tool);
      if (row.phase === "total") measured += Number(row.count);
      console.log(
        [tool, row.phase, row.count, row.total, Number(row.mean).toFixed(1), row.p90, row.max].join(
          "\t",
        ),
      );
    }
    console.log(`有总耗时 / Timed results: ${measured}/${count ?? 0}`);
    console.log(
      "旧事件缺失的阶段不计为 0；次数是各阶段的有效样本数。 / Missing historical phases are excluded; counts are valid samples per phase.",
    );
    // Only fixed enum values are projected; URLs, arguments and result text are never selected.
    const markers = db.prepare(`
      WITH events AS (
        SELECT CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS p
        FROM run_events WHERE kind='tool.result' AND at>=? AND at<=?
      )
      SELECT json_extract(p,'$.cache') AS cache,json_extract(p,'$.providerFallback') AS fallback,
        COUNT(*) AS count FROM events
      WHERE json_extract(p,'$.cache') IN ('hit','miss')
        AND json_extract(p,'$.providerFallback') IN ('none','duckduckgo_unavailable','duckduckgo_blocked')
      GROUP BY cache,fallback ORDER BY cache,fallback
    `);
    for (const row of markers.iterate(since, through))
      console.log(`web cache=${row.cache} providerFallback=${row.fallback} count=${row.count}`);
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
} catch (error) {
  fail(error);
}

function safeTool(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value)
    ? value
    : "unknown_tool";
}
