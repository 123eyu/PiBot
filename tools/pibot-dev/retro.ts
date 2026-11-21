import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { store } from "./context.ts";
import { acquireDirectoryLock } from "./operation-lock.ts";
import { readRetroEvents } from "./retro-events.ts";
import { attribution, buildRetro, taskDigest } from "./retro-facts.ts";
import type { RetroAttribution, RetroMetric, RetroSummary } from "./retro-types.ts";
import type { TaskRecord } from "./state.ts";

export const TOOL_ERROR_ROW = "工具错误（固定类别）";
export type RetroOptions = {
  dataDir?: string;
  attribution?: RetroAttribution;
  signal?: AbortSignal;
};
const display = (metric: RetroMetric, scale = 1) =>
  metric.value === null
    ? "unknown"
    : `${Number((metric.value / scale).toFixed(2))}${metric.coverage === "partial" ? " (partial)" : ""}`;
export function retroMarkdown(summary: RetroSummary) {
  const rows = Object.entries(summary.metrics).map(([name, value]) => [name, display(value)]);
  rows.push(
    ...Object.entries(summary.failures).map(([name, value]) => [`failure.${name}`, display(value)]),
  );
  rows.push(
    ...Object.entries(summary.usage).map(([name, value]) => [`usage.${name}`, display(value)]),
  );
  for (const [step, outcomes] of Object.entries(summary.steps))
    for (const [outcome, count] of Object.entries(outcomes))
      rows.push([`${step}.${outcome}`, String(count)]);
  return [
    `# ${summary.taskId} 复盘数据`,
    "",
    `版本 ${summary.version} · source ${summary.inputDigest}`,
    `日志覆盖 ${summary.logSource.status} (${summary.logSource.reason})`,
    `明确运行 ${summary.attribution.runIds?.length ?? 0} · 群归属 ${summary.attribution.groupId ?? "unknown"} · 群收据覆盖 ${summary.attribution.groupCoverage ?? "unknown"}（历史缺失归属不推断）`,
    "",
    "| 指标 | 值 |",
    "|---|---|",
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    "",
  ].join("\n");
}
/** Lock the publication separately; stateStore still owns its original atomic global state lock. */
export function retro(task: TaskRecord, options: RetroOptions = {}) {
  if (!/^[a-z0-9-]+$/.test(task.id)) throw new Error("retro_task_identity_invalid");
  options.signal?.throwIfAborted();
  const directory = join(store.dir, "retro");
  mkdirSync(directory, { recursive: true });
  const release = acquireDirectoryLock(join(directory, `${task.id}.lock`));
  let summary: RetroSummary | undefined;
  try {
    store.update((state) => {
      const current = state.tasks[task.id];
      if (!current || current.branch !== task.branch || current.worktree !== task.worktree)
        throw new Error("retro_task_identity_changed");
      const owner = attribution(
        current,
        options.attribution ??
          (current.target?.kind === "group" ? undefined : current.retro?.attribution),
      );
      const hasOwner =
        owner.runIds?.length || (current.target?.kind !== "group" && owner.sessionIds?.length);
      const source = hasOwner
        ? readRetroEvents(current, options.dataDir ?? process.env.PIBOT_DATA_DIR, options.signal)
        : {
            events: [],
            logSource: { status: "unknown" as const, reason: "missing_attribution" as const },
          };
      if (!hasOwner) source.logSource = { status: "unknown", reason: "missing_attribution" };
      summary = buildRetro(current, {
        ...source,
        attribution: owner,
        generatedAt: new Date().toISOString(),
      });
      if (
        current.retro?.inputDigest === summary.inputDigest &&
        JSON.stringify([
          current.retro.attribution,
          current.retro.metrics,
          current.retro.failures,
          current.retro.usage,
          current.retro.logSource,
        ]) ===
          JSON.stringify([
            summary.attribution,
            summary.metrics,
            summary.failures,
            summary.usage,
            summary.logSource,
          ])
      )
        summary.generatedAt = current.retro.generatedAt;
      current.retro = summary;
    });
    if (!summary) throw new Error("retro_state_write_failed");
    const saved = summary;
    options.signal?.throwIfAborted();
    const text = retroMarkdown(summary);
    const target = join(directory, `${task.id}.md`),
      pending = `${target}.${randomUUID()}.tmp`;
    // Exclusive creation establishes ownership: cleanup never removes somebody else's file.
    const fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let publishError: unknown;
    let publishFailed = false;
    try {
      try {
        writeFileSync(fd, text);
      } finally {
        closeSync(fd);
      }
      renameSync(pending, target);
    } catch (error) {
      publishFailed = true;
      publishError = error;
    }
    try {
      unlinkSync(pending);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("retro_temporary_cleanup_failed");
    }
    if (publishFailed) throw publishError;
    let stale = false;
    store.update((state) => {
      const current = state.tasks[task.id];
      if (!current?.retro || current.retro.inputDigest !== saved.inputDigest)
        throw new Error("retro_task_identity_changed");
      stale = taskDigest(current) !== saved.inputDigest;
      current.retro.publication = stale ? "stale" : "ready";
    });
    if (stale) throw new Error("retro_task_changed_retry");
    return text;
  } catch (error) {
    if (summary) {
      const failed = summary;
      store.update((state) => {
        const current = state.tasks[task.id];
        if (
          current?.retro &&
          current.retro.inputDigest === failed.inputDigest &&
          current.retro.publication !== "stale"
        )
          current.retro.publication = "failed";
      });
    }
    if (options.signal?.aborted) throw new Error("retro_cancelled");
    if (error instanceof Error && /^retro_[a-z_]+$/.test(error.message)) throw error;
    throw new Error("retro_write_failed");
  } finally {
    release();
  }
}
