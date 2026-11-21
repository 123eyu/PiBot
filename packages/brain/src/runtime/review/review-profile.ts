import {
  type ReviewProfile,
  ReviewProfileSchema,
  RpcError,
  type TaskSummary,
} from "@pibot/protocol-base";
import type { ReviewExecutionsRepo } from "@pibot/storage";
import { z } from "zod";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

const allowed = new Set([
  "tool_discover",
  "review_read",
  "read_file",
  "list_dir",
  "find_files",
  "search_text",
  "code_navigate",
  "review_finding",
  "task_status",
  "delivery_evidence",
]);
export class ReviewGuard {
  constructor(
    private readonly local: LocalService,
    private readonly repo: ReviewExecutionsRepo,
  ) {}
  bindTask(profile: ReviewProfile, task: TaskSummary) {
    const record = this.repo.get(profile.reviewId);
    if (
      !record ||
      record.summary.snapshotHash !== profile.snapshotHash ||
      record.summary.parentRunId !== task.parentRunId ||
      record.summary.rootRunId !== task.rootRunId ||
      record.summary.botId !== task.botId ||
      record.summary.conversationId !== task.conversationId ||
      (record.summary.taskId && record.summary.taskId !== task.id)
    )
      throw new RpcError(-32602, "review_scope_invalid");
    this.repo.save({
      ...record.summary,
      taskId: task.id,
      reviewerRunId: task.runId,
      status: record.summary.status === "capturing" ? "queued" : record.summary.status,
      updatedAt: new Date().toISOString(),
    });
  }
  profile(context: ToolRunContext): ReviewProfile | undefined {
    if (!context.executionTaskId) return;
    const record = this.repo.forTask(context.executionTaskId);
    const internal = this.local.tasks.tasks.internal(context.executionTaskId);
    const declared = z
      .object({ reviewProfile: ReviewProfileSchema.optional() })
      .parse(internal?.authority ?? {}).reviewProfile;
    if (!record) {
      if (declared) throw new RpcError(-32602, "review_snapshot_unavailable");
      return;
    }
    this.local.tasks.guardSync(context);
    const source = this.local.tasks.source(context);
    if (
      record.summary.botId !== context.botId ||
      source.conversationId !== record.summary.conversationId ||
      record.summary.rootRunId !== this.local.budgets.root(context)
    )
      throw new RpcError(-32602, "review_scope_invalid");
    const profile = {
      kind: "review" as const,
      reviewId: record.summary.id,
      snapshotHash: record.summary.snapshotHash,
    };
    if (
      !declared ||
      declared.reviewId !== profile.reviewId ||
      declared.snapshotHash !== profile.snapshotHash
    )
      throw new RpcError(-32602, "review_scope_invalid");
    return profile;
  }
  guardTool(context: ToolRunContext, tool: string) {
    const profile = this.profile(context);
    if (profile) {
      const record = this.repo.get(profile.reviewId);
      if (
        record &&
        (record.summary.status === "queued" || record.summary.reviewerRunId !== context.runId)
      ) {
        const summary = {
          ...record.summary,
          status: "running" as const,
          reviewerRunId: context.runId,
          updatedAt: new Date().toISOString(),
        };
        this.repo.save(summary);
        this.local.deps.peer.emit("review.execution.changed", {
          botId: summary.botId,
          conversationId: summary.conversationId,
          id: summary.id,
        });
      }
    }
    if ((profile && !allowed.has(tool)) || (!profile && tool === "review_read")) {
      this.local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "exec.finished",
        summary: "Read-only review tool denied",
        detail: { toolName: tool, reasonCode: "review_readonly" },
      });
      throw new RpcError(-32602, "review_readonly");
    }
  }
  allowsTool(context: ToolRunContext, tool: string) {
    return this.profile(context) ? allowed.has(tool) : tool !== "review_read";
  }
}
