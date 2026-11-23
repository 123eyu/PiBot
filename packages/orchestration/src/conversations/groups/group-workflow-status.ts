import {
  BotsRepo,
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  type GroupWorkflowsRepo,
  MessagesRepo,
} from "@pibot/storage";
import { stepWorkspaces } from "./group-plan-progress.ts";
import type { GroupService } from "./group-service.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";
import { verdictStepLabel } from "./group-workflow-verdicts.ts";

const MERGE_MS = 2_000;

/**
 * The group hears progress from the program, not from a model turn. Every line is built
 * from the step rows the scheduler already persisted, so nothing here can leak a member's prose.
 */
export function workflowStatusText(
  record: GroupWorkflowRunRecord,
  steps: readonly GroupWorkflowStepRecord[],
  names: Map<string, string>,
  language: "zh" | "en",
  /** Maintainers 2026-11-14: where each writing step's work is, so merges show as they happen. */
  workspaces: ReadonlyMap<string, string | undefined> = new Map(),
  conflicts: Record<string, { files: string[] }> = {},
) {
  const zh = language === "zh";
  const workflow = workflowOf(record);
  const titles = new Map(workflow.contract.steps?.map((step) => [step.id, step.title]));
  const title = (stepId: string) => titles.get(stepId) ?? stepId;
  const owner = (stepId: string) =>
    names.get(steps.find((step) => step.stepId === stepId)?.ownerBotId ?? "") ?? "";
  const done = steps.filter((step) => ["passed", "skipped"].includes(step.status));
  const running = steps.filter(
    (step) => step.status === "running" && workspaces.get(step.stepId) !== "shared",
  );
  const held = new Set(Object.keys(progressOf(record).paused ?? {}));
  const paused = steps.filter((step) => step.status === "ready" && held.has(step.stepId));
  const ready = steps.filter(
    (step) =>
      (step.status === "ready" ||
        (step.status === "running" && workspaces.get(step.stepId) === "shared")) &&
      !held.has(step.stepId),
  );
  const blocked = steps.filter((step) => step.status === "blocked");
  const lines = [
    zh
      ? `计划「${workflow.name}」进度 ${done.length}/${steps.length}`
      : `Plan “${workflow.name}” progress ${done.length}/${steps.length}`,
  ];
  const merge = (stepId: string) => {
    const state = workspaces.get(stepId);
    if (state === "merged") return zh ? "，已合并" : ", merged";
    if (state === "merging") return zh ? "，等待合并" : ", waiting to merge";
    return "";
  };
  for (const step of done.slice(-3)) {
    const verdict = verdictStepLabel(progressOf(record), step.stepId, zh);
    const label = verdict
      ? verdict
      : step.status === "passed"
        ? zh
          ? "已完成"
          : "done"
        : zh
          ? "已跳过"
          : "skipped";
    lines.push(
      zh
        ? `• ${title(step.stepId)}：${label}${merge(step.stepId)}${owner(step.stepId) ? `（${owner(step.stepId)}）` : ""}`
        : `• ${title(step.stepId)}: ${label}${merge(step.stepId)}${owner(step.stepId) ? ` (${owner(step.stepId)})` : ""}`,
    );
  }
  for (const step of running)
    lines.push(
      zh
        ? `• 正在做：${title(step.stepId)}${owner(step.stepId) ? `（${owner(step.stepId)}）` : ""}`
        : `• In progress: ${title(step.stepId)}${owner(step.stepId) ? ` (${owner(step.stepId)})` : ""}`,
    );
  for (const step of paused)
    lines.push(
      zh
        ? `• 已暂停：${title(step.stepId)}${owner(step.stepId) ? `（${owner(step.stepId)}）` : ""}，继续后接着做`
        : `• Paused: ${title(step.stepId)}${owner(step.stepId) ? ` (${owner(step.stepId)})` : ""}; continues when you resume`,
    );
  for (const step of ready.slice(0, 3))
    lines.push(
      zh
        ? `• 接下来：${title(step.stepId)}${owner(step.stepId) ? `（${owner(step.stepId)}）` : ""}`
        : `• Up next: ${title(step.stepId)}${owner(step.stepId) ? ` (${owner(step.stepId)})` : ""}`,
    );
  for (const step of blocked) {
    if (workspaces.get(step.stepId) === "conflict") {
      const files = (conflicts[step.stepId]?.files ?? []).slice(0, 5).join(zh ? "、" : ", ");
      lines.push(
        zh
          ? `• 合并冲突：${title(step.stepId)}${owner(step.stepId) ? `（${owner(step.stepId)}）` : ""}${files ? `，冲突文件：${files}` : ""}；由统筹处置`
          : `• Merge conflict: ${title(step.stepId)}${owner(step.stepId) ? ` (${owner(step.stepId)})` : ""}${files ? `; files: ${files}` : ""}; the coordinator handles it`,
      );
      continue;
    }
    const next = step.decisionMessageId
      ? zh
        ? "等待你决定"
        : "waiting for your decision"
      : zh
        ? "由统筹处置"
        : "the coordinator handles it";
    lines.push(
      zh
        ? `• 卡住：${title(step.stepId)}${owner(step.stepId) ? `（${owner(step.stepId)}）` : ""}，${next}`
        : `• Stuck: ${title(step.stepId)}${owner(step.stepId) ? ` (${owner(step.stepId)})` : ""}; ${next}`,
    );
  }
  return lines.join("\n");
}

/**
 * One message per burst: a step transition can settle several steps at once (a failed step blocks
 * the rest), and the user should read one summary, not one line per row.
 */
export class GroupWorkflowStatus {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly last = new Map<string, string>();

  constructor(
    private readonly service: GroupService,
    private readonly repo: GroupWorkflowsRepo,
  ) {}

  announce(record: GroupWorkflowRunRecord) {
    if (this.service.signal.aborted || this.timers.has(record.id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(record.id);
      try {
        this.flush(record.id);
      } catch {
        // A status line is decoration: a failure here must never break the workflow transition.
      }
    }, MERGE_MS);
    timer.unref();
    this.timers.set(record.id, timer);
  }

  private flush(workflowRunId: string) {
    if (this.service.signal.aborted) return;
    const record = this.repo.get(workflowRunId);
    if (!record || !["running", "waiting"].includes(record.status)) {
      this.last.delete(workflowRunId);
      return;
    }
    const group = this.service.groups.get(record.groupId);
    if (!group) return;
    const steps = this.repo.steps(workflowRunId);
    const bots = new BotsRepo(this.service.deps.db);
    const names = new Map<string, string>();
    for (const step of steps) {
      if (names.has(step.ownerBotId)) continue;
      names.set(
        step.ownerBotId,
        this.service.deps.redactor.redact(bots.get(step.ownerBotId)?.name ?? ""),
      );
    }
    const text = workflowStatusText(
      record,
      steps,
      names,
      this.service.deps.chat.currentLanguage(),
      stepWorkspaces(this.service, record, steps),
      progressOf(record).merges,
    );
    // Nothing moved since the last line (a replay or a coalesced duplicate): stay quiet.
    if (this.last.get(workflowRunId) === text) return;
    new MessagesRepo(this.service.deps.db).create({
      conversationId: group.conversationId,
      botId: record.coordinatorBotId,
      role: "assistant",
      content: this.service.deps.redactor.redact(text),
      status: "done",
      // Structural marker so the renderer can keep these program lines out of the model transcript.
      usage: { groupWorkflowStatus: { workflowRunId } },
    });
    this.last.set(workflowRunId, text);
    this.service.changed(record.groupId, "updated");
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.last.clear();
  }
}
