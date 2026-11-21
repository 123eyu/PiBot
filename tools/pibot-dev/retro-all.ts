import { store } from "./context.ts";
import { type RetroOptions, retro } from "./retro.ts";
import { finite, metric, taskDigest } from "./retro-facts.ts";
import type { RetroMetric, RetroSummary } from "./retro-types.ts";

export interface RetroAllOptions extends RetroOptions {
  since?: string;
}
export function aggregateRetros(summaries: RetroSummary[]) {
  const metrics: Record<string, RetroMetric[]> = {};
  const add = (key: string, value: RetroMetric) => {
    metrics[key] ??= [];
    metrics[key].push(value);
  };
  const steps: RetroSummary["steps"] = {};
  for (const summary of summaries) {
    for (const [key, value] of Object.entries(summary.metrics)) add(key, value);
    for (const [key, value] of Object.entries(summary.usage)) add(`usage.${key}`, value);
    for (const [key, value] of Object.entries(summary.failures)) add(`failure.${key}`, value);
    for (const [step, outcomes] of Object.entries(summary.steps))
      for (const [outcome, value] of Object.entries(outcomes)) {
        steps[step] ??= {};
        const target = steps[step];
        target[outcome] = (target[outcome] ?? 0) + value;
      }
  }
  return {
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, values]) => {
        const known = values.filter((value) => finite(value.value));
        return [
          key,
          {
            ...metric(
              known.length ? known.reduce((sum, value) => sum + (value.value ?? 0), 0) : null,
              values.every((value) => value.coverage === "complete") ? "complete" : "partial",
            ),
            known: known.length,
            total: values.length,
          },
        ];
      }),
    ),
    steps,
  };
}
/** Aggregation consumes versioned facts, never Markdown rows or review/error prose. */
export function retroAll(options: RetroAllOptions = {}) {
  if (options.since && !Number.isFinite(Date.parse(options.since)))
    throw new Error("retro_since_invalid");
  const state = store.read();
  const tasks = Object.values(state.tasks).filter(
    (task) =>
      !options.since ||
      task.steps.some((step) => Date.parse(step.at) >= Date.parse(options.since as string)),
  );
  const summaries: RetroSummary[] = [];
  let failed = 0;
  for (const task of tasks) {
    options.signal?.throwIfAborted();
    try {
      if (
        task.retro?.version !== 1 ||
        task.retro.inputDigest !== taskDigest(task) ||
        task.retro.publication !== "ready" ||
        options.dataDir ||
        process.env.PIBOT_DATA_DIR ||
        options.attribution
      )
        retro(task, options);
      const current = store.read().tasks[task.id];
      if (
        current?.retro?.version !== 1 ||
        current.retro.inputDigest !== taskDigest(current) ||
        current.retro.publication !== "ready"
      )
        throw new Error("retro_stale");
      summaries.push(current.retro);
    } catch {
      if (options.signal?.aborted) throw new Error("retro_cancelled");
      failed++;
    }
  }
  const result = aggregateRetros(summaries);
  return [
    `# pibot-dev 复盘汇总${options.since ? `（自 ${options.since}）` : ""}`,
    "",
    `任务 ${tasks.length} · 结构化复盘 ${summaries.length} · 失败或过期 ${failed}`,
    "按同一结构化事实聚合；unknown 不是零，partial 仅为已观察小计。群复盘只统计明确收据中的运行，历史缺失归属不推断。",
    "",
    "| 指标 | 值 | 覆盖任务 |",
    "|---|---|---|",
    ...Object.entries(result.metrics).map(
      ([key, value]) =>
        `| ${key} | ${value.value ?? "unknown"} (${value.coverage}) | ${value.known}/${value.total} |`,
    ),
    ...Object.entries(result.steps).flatMap(([step, outcomes]) =>
      Object.entries(outcomes).map(
        ([outcome, count]) => `| ${step}.${outcome} | ${count} | recorded steps |`,
      ),
    ),
    "",
  ].join("\n");
}
