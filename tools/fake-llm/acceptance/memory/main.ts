import { join } from "node:path";
import { contextHint, history, organization, recall } from "./cases.ts";
import { extraction } from "./extraction.ts";
import { groupMemory } from "./group.ts";
import { budget, options } from "./options.ts";
import { requestSummary } from "./requests.ts";
import { ProbeFailure, type Runtime, requireThat, runtime } from "./runtime.ts";
import { scopeMoves, userBudget } from "./scope.ts";
import { ownerSort } from "./sort.ts";

interface Maintenance {
  rows: number;
  tokens: number;
  costUsd: number;
}
export async function main(root: string, argv: string[], report: (line: string) => void) {
  const o = options(argv);
  const ledger = budget(o);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let failed = 0;
  const maintenance: Record<string, Maintenance> = {};
  const cache = { input: 0, read: 0, write: 0, rows: 0 };
  const collect = (r: Runtime) => {
    for (const table of ["memory_extractions", "memory_organizations"]) {
      const row = r.db
        .prepare(
          `SELECT count(*) AS rows, coalesce(sum(tokens),0) AS tokens, coalesce(sum(cost_usd),0) AS cost FROM ${table} WHERE status='done'`,
        )
        .get()!;
      maintenance[table] ??= { rows: 0, tokens: 0, costUsd: 0 };
      const total = maintenance[table];
      total.rows += Number(row.rows);
      total.tokens += Number(row.tokens);
      total.costUsd += Number(row.cost);
    }
    for (const row of r.db
      .prepare("SELECT usage FROM messages WHERE role='assistant' AND usage IS NOT NULL")
      .all()) {
      const usage = JSON.parse(String(row.usage)) as {
        input?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      if (typeof usage.input === "number") {
        cache.rows++;
        cache.input += usage.input;
        cache.read += usage.cacheRead ?? 0;
        cache.write += usage.cacheWrite ?? 0;
      }
    }
  };
  const run = async (
    n: number,
    label: string,
    test: (r: Runtime, signal: AbortSignal) => Promise<void>,
    fakeOnly = false,
  ) => {
    let r: Runtime | undefined;
    let reason: string | undefined;
    let memoryAdds = 0;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(o.timeoutMs)]);
    try {
      signal.throwIfAborted();
      r = await runtime(
        join(root, `case-${n}`),
        fakeOnly ? { ...o, real: false } : o,
        ledger,
        signal,
      );
      await test(r, signal);
    } catch (error) {
      reason =
        !fakeOnly && ledger.blocked
          ? ledger.blocked
          : error instanceof ProbeFailure
            ? error.message
            : signal.aborted
              ? "cancelled_or_timeout"
              : "rpc_model_or_fixture_failed";
    } finally {
      if (r) {
        try {
          collect(r);
          if (n === 2)
            memoryAdds = Number(
              r.db
                .prepare(
                  "SELECT count(*) AS n FROM tool_calls WHERE tool='memory_add' AND status='done'",
                )
                .get()?.n ?? 0,
            );
        } catch {
          reason ??= "usage_read_failed";
        }
        try {
          await r.close();
        } catch {
          reason ??= "cleanup_failed";
        }
      }
    }
    if (reason) failed++;
    const diagnostic =
      (n === 1 || n === 2 || n === 7) && r
        ? `; ${requestSummary(r.requests)}${n === 2 ? `; memory_add_done_${memoryAdds}` : ""}`
        : "";
    report(
      `${reason ? "FAIL" : "ok"} ${n} ${label}: ${reason ?? (o.real && !fakeOnly ? "真实模型检查通过" : "流程检查通过；语义质量需真实模型确认")}${diagnostic}`,
    );
  };
  try {
    await run(1, "目录与按需召回", recall);
    await run(2, "归档提炼/ask/auto/撤销/开关/六小时仓储", (r, signal) =>
      extraction(r, join(root, "case-2"), signal),
    );
    await run(3, "跨话题检索与Bot隔离", history);
    await run(4, "整理提议/确认/合并/撤销", organization);
    try {
      requireThat(
        (maintenance.memory_extractions?.rows ?? 0) >= 2 &&
          (maintenance.memory_organizations?.rows ?? 0) >= 1,
        "maintenance_usage_missing",
      );
      requireThat(
        Object.values(maintenance).every((m) => m.tokens > 0 && m.costUsd > 0) && cache.rows > 0,
        "usage_tokens_cost_or_cache_missing",
      );
      report(
        "ok 5 用量记录: " +
          JSON.stringify({
            mode: o.real ? "real" : "synthetic",
            maintenance,
            cacheSource: "assistant-message-usage",
            cacheRead: cache.read,
            input: cache.input,
            cacheWrite: cache.write,
            cacheReadRate:
              cache.input + cache.read + cache.write > 0
                ? cache.read / (cache.input + cache.read + cache.write)
                : null,
            reservedUpperBoundUsd: ledger.reserved,
          }),
      );
    } catch (error) {
      failed++;
      const code =
        error instanceof ProbeFailure &&
        ["maintenance_usage_missing", "usage_tokens_cost_or_cache_missing"].includes(error.message)
          ? error.message
          : "usage_check_failed";
      report(
        `FAIL 5 用量记录: 缺少已完成提炼/整理的花费、token或聊天缓存记录; ${code}; ` +
          JSON.stringify({ maintenance, assistantUsageRows: cache.rows }),
      );
    }
    await run(6, "长短话题切换32k提示", contextHint, true);
    await run(7, "群共识提炼/ask/auto/成员步骤召回/撤销", groupMemory);
    await run(8, "用户记忆常驻预算/目录/召回/工作事实进Bot范围", userBudget);
    await run(9, "用户范围工作事实移动提议/确认/撤销/不重复", scopeMoves, true);
    await run(10, "主人整理归位/来源/确认副本/撤销/取消/记账门禁", ownerSort, true);
    return failed ? 1 : 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    o.key = undefined;
  }
}
