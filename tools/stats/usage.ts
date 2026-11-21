// Reads the aggregate counters on the update server and the official relay. The secrets come
// from the environment or ~/.pibot-stats (created when the Worker secrets were set), never the repo.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    site: { type: "string", default: "https://pibot.space" },
    relay: { type: "string", default: "https://relay.pibot.space" },
    json: { type: "boolean" },
  },
});
const from = values.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
  console.error("用法：pnpm stats:usage [--from YYYY-MM-DD] [--json]");
  process.exit(2);
}

async function secret(variable: string, file: string) {
  const fromEnv = process.env[variable]?.trim();
  if (fromEnv) return fromEnv;
  try {
    return (await readFile(join(homedir(), ".pibot-stats", file), "utf8")).trim();
  } catch {
    return undefined;
  }
}

async function read<T>(base: string, token: string | undefined) {
  if (!token) return { missing: true as const };
  try {
    const response = await fetch(`${base}/_stats?from=${from}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { status: String(response.status) };
    return { data: (await response.json()) as T };
  } catch {
    return { status: "network" };
  }
}

type UpdateRow = {
  day: string;
  source: string;
  version: string;
  platform: string;
  arch: string;
  count: number;
};
type RelayRow = { day: string; role: string; kind: string; count: number };
const updates = await read<{ rows: UpdateRow[] }>(
  values.site,
  await secret("PIBOT_STATS_SITE_TOKEN", "site-token"),
);
const relay = await read<{ rows: RelayRow[] }>(
  values.relay,
  await secret("PIBOT_STATS_RELAY_TOKEN", "relay-token"),
);

if (values.json) {
  console.log(JSON.stringify({ from, updates, relay }, null, 2));
  process.exit(0);
}

function sumBy<T>(rows: T[], key: (row: T) => string, count: (row: T) => number) {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(key(row), (totals.get(key(row)) ?? 0) + count(row));
  return [...totals].sort(([a], [b]) => a.localeCompare(b));
}

console.log(`统计区间：${from} 起（只含聚合计数，没有任何标识）`);
if ("data" in updates && updates.data) {
  const rows = updates.data.rows;
  console.log("\n更新检查（每天）：自动检查约每 4 小时一次，自动次数 ÷ 6 粗估当天开着的安装数");
  for (const [day, n] of sumBy(
    rows,
    (r) => `${r.day} ${r.source}`,
    (r) => r.count,
  ))
    console.log(`  ${day.padEnd(18)} ${n}`);
  console.log("按版本（自动 + 手动）：");
  for (const [version, n] of sumBy(
    rows,
    (r) => r.version,
    (r) => r.count,
  ))
    console.log(`  ${version.padEnd(10)} ${n}`);
  console.log("按平台：");
  for (const [platform, n] of sumBy(
    rows,
    (r) => `${r.platform}-${r.arch}`,
    (r) => r.count,
  ))
    console.log(`  ${platform.padEnd(16)} ${n}`);
} else
  console.log(
    "\n更新检查：",
    "missing" in updates
      ? "没有 token（PIBOT_STATS_SITE_TOKEN 或 ~/.pibot-stats/site-token）"
      : `读取失败 ${updates.status}`,
  );
if ("data" in relay && relay.data) {
  console.log("\n官方中继连接（每天 × 角色 / 房间类型）：");
  for (const [key, n] of sumBy(
    relay.data.rows,
    (r) => `${r.day} ${r.role}/${r.kind}`,
    (r) => r.count,
  ))
    console.log(`  ${key.padEnd(26)} ${n}`);
} else
  console.log(
    "\n官方中继：",
    "missing" in relay
      ? "没有 token（PIBOT_STATS_RELAY_TOKEN 或 ~/.pibot-stats/relay-token）"
      : `读取失败 ${relay.status}`,
  );
