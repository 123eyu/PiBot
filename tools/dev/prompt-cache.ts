import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { cacheRequestGaps } from "./cache-request-gaps.ts";
import { dataRoot } from "./data.ts";
import { fail } from "./process.ts";

/**
 * Reads the cache columns the model already reported for every assistant turn, so a prompt change
 * can be judged on measured `cacheRead` instead of on how the code looks. Read-only and content-free:
 * it never selects message text, tool arguments or reasons.
 */
const { values } = parseArgs({
  options: {
    data: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  },
});

const limit = values.limit === undefined ? 5000 : Number(values.limit);
if (!Number.isInteger(limit) || limit <= 0 || limit > 100_000)
  fail("--limit 必须是 1–100000 的整数 / --limit must be an integer between 1 and 100000");

const dir = values.data ? resolve(values.data) : join(dataRoot, "default");
const file = join(dir, "pibot.db");
if (!existsSync(file)) {
  fail(`找不到数据库 / no database at ${file}`);
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
try {
  db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
  const rows: Array<{
    conversation_id: string;
    bot_id: string | null;
    created_at: string;
    usage: string;
  }> = db
    .prepare(
      `SELECT conversation_id,bot_id,created_at,usage FROM messages
         WHERE role='assistant' AND usage IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as never;
  {
    const turns = [...rows].reverse().map(turn);
    const report = { ...summarize(turns), requestIntervals: await cacheRequestGaps(dir, limit) };
    if (!rows.length && !report.requestIntervals.sampled) process.exitCode = 1;
    if (values.json === true) console.log(JSON.stringify(report, null, 2));
    else {
      print(report, dir);
      console.log(
        "Request gaps by API / 按 API 的请求间隔（最新追加收据；最多14个日文件/512MiB；历史缺间隔不推算）",
      );
      for (const bucket of report.requestIntervals.buckets)
        console.log(
          `${bucket.api} ${bucket.interval}: ${bucket.requests} requests, cache hit ${bucket.hitRate}%`,
        );
      console.log(
        `unknown interval ${report.requestIntervals.unknownInterval}; missing usage ${report.requestIntervals.missingUsage}; truncated ${report.requestIntervals.truncated}`,
      );
    }
  }
} finally {
  db.close();
}

type Turn = {
  conversationId: string;
  botId: string | null;
  at: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
};

function turn(row: {
  conversation_id: string;
  bot_id: string | null;
  created_at: string;
  usage: string;
}) {
  let usage: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.usage);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      usage = parsed as Record<string, unknown>;
  } catch {
    // A row whose usage column is not JSON still counts as a turn; it simply reports zeros.
  }
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    conversationId: row.conversation_id,
    botId: row.bot_id,
    at: row.created_at,
    input: num(usage.input),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
  } satisfies Turn;
}

function summarize(turns: Turn[]) {
  const byConversation = new Map<string, Turn[]>();
  for (const item of turns) {
    const list = byConversation.get(item.conversationId) ?? [];
    list.push(item);
    byConversation.set(item.conversationId, list);
  }
  const totals = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
  const conversations = [...byConversation.entries()].map(([conversationId, list]) => {
    const sum = { input: 0, cacheRead: 0, cacheWrite: 0 };
    for (const item of list) {
      sum.input += item.input;
      sum.cacheRead += item.cacheRead;
      sum.cacheWrite += item.cacheWrite;
    }
    totals.turns += list.length;
    totals.input += sum.input;
    totals.cacheRead += sum.cacheRead;
    totals.cacheWrite += sum.cacheWrite;
    return {
      conversationId,
      turns: list.length,
      input: sum.input,
      cacheRead: sum.cacheRead,
      cacheWrite: sum.cacheWrite,
      // Share of prompt tokens that came from cache; the rest is re-read and paid in full.
      hitRate: ratio(sum.cacheRead, sum.input + sum.cacheRead + sum.cacheWrite),
      first: list[0]?.at ?? "",
      last: list.at(-1)?.at ?? "",
    };
  });
  conversations.sort((a, b) => b.last.localeCompare(a.last));
  return {
    conversations,
    totals: {
      ...totals,
      hitRate: ratio(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite),
    },
  };
}

function ratio(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 100 : 0;
}

function print(
  report: {
    conversations: Array<{
      conversationId: string;
      turns: number;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      hitRate: number;
      last: string;
    }>;
    totals: {
      turns: number;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      hitRate: number;
    };
  },
  dir: string,
) {
  const pad = (value: string | number, width: number) => String(value).padStart(width);
  console.log(`数据目录 / data dir: ${dir}`);
  console.log("会话 conversation      轮次  input      cacheRead  cacheWrite 命中%  最后");
  for (const item of report.conversations.slice(0, 30)) {
    console.log(
      `${item.conversationId.slice(0, 18)} ${pad(item.turns, 5)} ${pad(item.input, 9)} ${pad(item.cacheRead, 10)} ${pad(item.cacheWrite, 11)} ${pad(item.hitRate, 6)}  ${item.last}`,
    );
  }
  const t = report.totals;
  console.log(
    `合计 / total：${t.turns} 轮，input ${t.input}，cacheRead ${t.cacheRead}，cacheWrite ${t.cacheWrite}，命中 ${t.hitRate}%`,
  );
}
