import { relative, resolve, sep } from "node:path";
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import { SemanticError } from "@pibot/execution/semantic";
import {
  type ReviewProfile,
  type ReviewSummary,
  RpcError,
  type Run,
  type TaskSummary,
} from "@pibot/protocol-base";
import {
  type ReviewExecutionRecord,
  ReviewExecutionsRepo,
  ReviewFindingsRepo,
} from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { redactValue } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import type { WriteLockOwner } from "../../resources/workplaces/folder-write-lock.ts";
import type { CodeNavigationService } from "./code-navigation.ts";
import { ReviewGuard } from "./review-profile.ts";
import { ReviewSnapshotFiles } from "./review-snapshot.ts";
import { frozenFile, readFrozenSnapshot } from "./review-snapshot-read.ts";
import { assertFrozenAccess, reviewSourceAccess } from "./review-source-access.ts";
import { type ReviewTaskPort, startReviewExecution } from "./review-start.ts";

type Scope = { botId: string; conversationId: string };
export class ReviewExecutionService {
  readonly repo: ReviewExecutionsRepo;
  private readonly files: ReviewSnapshotFiles;
  private tasks?: ReviewTaskPort;
  private navigation?: CodeNavigationService;
  private captures = 0;
  private readonly guard: ReviewGuard;
  constructor(private readonly local: LocalService) {
    this.repo = new ReviewExecutionsRepo(local.deps.db);
    this.repo.recover();
    this.guard = new ReviewGuard(local, this.repo);
    this.files = new ReviewSnapshotFiles(local.deps.dataDir);
  }
  attachTasks(port: ReviewTaskPort) {
    this.tasks = port;
  }
  attachNavigation(port: CodeNavigationService) {
    this.navigation = port;
  }
  bindTask(profile: ReviewProfile, task: TaskSummary) {
    return this.guard.bindTask(profile, task);
  }
  profile(context: ToolRunContext) {
    return this.guard.profile(context);
  }
  guardTool(context: ToolRunContext, tool: string) {
    return this.guard.guardTool(context, tool);
  }
  allowsTool(context: ToolRunContext, tool: string) {
    return this.guard.allowsTool(context, tool);
  }
  private scope(scope: Scope) {
    this.local.execution.get(scope);
    return scope;
  }
  private emit(summary: ReviewSummary) {
    this.local.deps.peer.emit("review.execution.changed", {
      botId: summary.botId,
      conversationId: summary.conversationId,
      id: summary.id,
    });
    this.local.approvals.audit.append({
      botId: summary.botId,
      runId: summary.parentRunId,
      kind: "exec.finished",
      summary: "Independent review state changed",
      detail: { target: summary.id, reasonCode: summary.status },
    });
  }
  private source(record: ReviewExecutionRecord, signal: AbortSignal): ToolRunContext {
    return { ...record.source, signal, language: "en" };
  }
  private async scoped(scope: Scope, id: string) {
    this.scope(scope);
    const record = this.repo.get(id);
    if (
      !record ||
      record.summary.botId !== scope.botId ||
      record.summary.conversationId !== scope.conversationId
    )
      throw new RpcError(-32602, "review_unavailable");
    return record;
  }
  async start(
    context: ToolRunContext,
    callId: string,
    input: unknown,
    signal: AbortSignal,
    onWait?: (holder?: WriteLockOwner) => void,
  ): Promise<LocalToolResult> {
    if (this.captures >= 2) throw new RpcError(-32602, "review_capture_busy");
    this.captures++;
    try {
      await this.cleanup(signal);
      return await startReviewExecution(
        {
          local: this.local,
          repo: this.repo,
          files: this.files,
          tasks: this.tasks,
          profile: (c) => this.profile(c),
          bindTask: (p, t) => this.bindTask(p, t),
          emit: (value) => this.emit(value),
          chosenReviewer: (authorBotId) => this.takeChoice(authorBotId),
        },
        context,
        callId,
        input,
        signal,
        onWait,
      );
    } finally {
      this.captures--;
    }
  }
  /**
   * The reviewer the user just picked in the changes pane. It is held per author Bot (a chat
   * without a topic has no conversation id yet) for the review request that follows and used
   * once; a stale pick (10 minutes) is dropped.
   */
  private readonly choices = new Map<
    string,
    { botId: string; at: number; review?: { scope: "turn" | "uncommitted" } }
  >();
  choose(authorBotId: string, botId: string, review?: { scope: "turn" | "uncommitted" }) {
    this.choices.set(authorBotId, { botId, at: Date.now(), ...(review ? { review } : {}) });
  }
  /**
   * An external agent cannot call review_start, so its run asks here whether the message it
   * received is the changes pane's review request. The reviewer pick itself stays for the
   * review_start that follows.
   */
  takeRequest(authorBotId: string) {
    const choice = this.choices.get(authorBotId);
    if (!choice?.review || Date.now() - choice.at >= 10 * 60_000) return;
    const { review, ...rest } = choice;
    this.choices.set(authorBotId, rest);
    return review;
  }
  private takeChoice(authorBotId: string) {
    const choice = this.choices.get(authorBotId);
    this.choices.delete(authorBotId);
    return choice && Date.now() - choice.at < 10 * 60_000 ? choice.botId : undefined;
  }
  private async cleanup(signal: AbortSignal) {
    for (const record of this.repo.expired(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    )) {
      signal.throwIfAborted();
      await this.files.remove(record.summary.id, record.summary.botId);
      this.repo.expire(record.summary.id);
      this.repo.save({
        ...record.summary,
        freshness: "unavailable",
        updatedAt: new Date().toISOString(),
      });
    }
  }
  /** Synchronous after AF6's actual drained terminal event; no detached finalizer. */
  settled(taskId: string, run: Run) {
    const record = this.repo.forTask(taskId);
    if (!record) return;
    const status =
      run.status === "done"
        ? "done"
        : run.status === "aborted"
          ? "aborted"
          : this.local.tasks.tasks.get(taskId)?.status === "interrupted"
            ? "interrupted"
            : "error";
    const summary = {
      ...record.summary,
      reviewerRunId: run.id,
      status,
      freshness: "checking" as const,
      updatedAt: new Date().toISOString(),
    } as ReviewSummary;
    this.repo.save(summary);
    this.emit(summary);
  }
  async get(scope: Scope, id: string, signal: AbortSignal): Promise<ReviewSummary> {
    const record = await this.scoped(scope, id);
    let freshness: ReviewSummary["freshness"] = "unavailable";
    try {
      if (!record.bytes) throw new RpcError(-32602, "review_snapshot_expired");
      const snapshot = await this.files.load(
        id,
        record.summary.botId,
        record.summary.snapshotHash,
        signal,
      );
      const access = await reviewSourceAccess(
        this.local,
        this.source(record, signal),
        record.root,
        signal,
      );
      const boundary = await import("../tools/local-read-boundary.ts").then(
        ({ createReadPathBoundary }) =>
          createReadPathBoundary(this.local, this.source(record, signal), signal),
      );
      await assertFrozenAccess(snapshot, access);
      if (boundary.workplace.cwd !== (record.source.worktreeReview?.source.path ?? record.root))
        freshness = "stale";
      else
        freshness = (await this.files.current(this.local, access, snapshot)) ? "current" : "stale";
    } catch (error) {
      signal.throwIfAborted();
      // Availability is a user-visible result; details stay out of the protocol and logs.
      if (!(error instanceof RpcError) && !(error instanceof Error && "code" in error)) throw error;
    }
    const latest = this.repo.get(id) as ReviewExecutionRecord;
    const task = latest.summary.taskId
      ? this.local.tasks.tasks.get(latest.summary.taskId)
      : undefined;
    const summary = {
      ...latest.summary,
      ...(task?.runId ? { reviewerRunId: task.runId } : {}),
      ...(task?.status === "running" ? { status: "running" as const } : {}),
      freshness,
    };
    this.repo.save(summary);
    return summary;
  }
  async list(
    scope: Scope,
    page: { before?: string; limit?: number; rootId?: string },
    signal: AbortSignal,
  ) {
    this.scope(scope);
    const records = this.repo.list(scope, page),
      items: ReviewSummary[] = [];
    // Rehash only on explicit get; listing never blocks the pane on multiple project scans.
    for (const record of records) {
      signal.throwIfAborted();
      items.push({ ...record.summary, freshness: "checking" });
    }
    return {
      items,
      next: records.length === (page.limit ?? 20) ? (records.at(-1)?.summary.id ?? null) : null,
    };
  }
  async findings(scope: Scope, id: string, signal: AbortSignal) {
    const review = await this.get(scope, id, signal);
    return {
      reviewId: review.id,
      snapshotHash: review.snapshotHash,
      freshness: review.freshness,
      ...this.repo.findings(id),
    };
  }
  private async snapshot(context: ToolRunContext, signal: AbortSignal) {
    const profile = this.profile(context);
    if (!profile) throw new RpcError(-32602, "review_unavailable");
    const record = this.repo.get(profile.reviewId);
    if (!record) throw new RpcError(-32602, "review_unavailable");
    const snapshot = await this.files.load(
        profile.reviewId,
        record.summary.botId,
        profile.snapshotHash,
        signal,
      ),
      access = await reviewSourceAccess(this.local, context, record.root, signal);
    await assertFrozenAccess(snapshot, access);
    access.assertCurrent(signal);
    return { snapshot, record };
  }
  async executeRead(
    context: ToolRunContext,
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<LocalToolResult> {
    const { snapshot } = await this.snapshot(context, signal);
    if (call.tool === "code_navigate") {
      if (!this.navigation) throw new SemanticError("unavailable", "semantic_unavailable");
      return this.navigation.snapshot(context, snapshot, call.input, signal);
    }
    const value = readFrozenSnapshot(snapshot, call, signal);
    this.profile(context);
    const text = JSON.stringify(redactValue(value, this.local.deps.redactor));
    return {
      text:
        text.length > 128 * 1024
          ? JSON.stringify({ truncated: true, text: text.slice(0, 120 * 1024) })
          : text,
    };
  }
  async recordFinding(
    context: ToolRunContext,
    input: {
      path: string;
      line?: number;
      endLine?: number;
      severity: "security" | "bug" | "suggestion";
      message: string;
    },
    signal: AbortSignal,
  ): Promise<LocalToolResult> {
    const { snapshot, record } = await this.snapshot(context, signal),
      path = relative(snapshot.root, resolve(snapshot.root, input.path)).split(sep).join("/");
    const text = frozenFile(snapshot, path),
      lines = text.split("\n").length;
    if ((input.line && input.line > lines) || (input.endLine && input.endLine > lines))
      throw new RpcError(-32602, "review_range_invalid");
    const finding = new ReviewFindingsRepo(this.local.deps.db).record({
      botId: context.botId,
      conversationId: record.summary.conversationId,
      ...(record.source.groupId ? { groupId: record.source.groupId } : {}),
      runId: context.runId,
      root: record.root,
      path,
      line: input.line ?? null,
      endLine: input.endLine ?? null,
      severity: input.severity,
      message: this.local.deps.redactor.redact(input.message).slice(0, 2000),
    });
    if (!finding) throw new RpcError(-32602, "review_finding_limit");
    const next = {
      ...record.summary,
      findingsCount: record.summary.findingsCount + 1,
      updatedAt: new Date().toISOString(),
    };
    this.repo.save(next);
    this.emit(next);
    this.local.deps.peer.emit("changes.changed", { runId: context.runId, reason: "review" });
    return {
      text: JSON.stringify({ id: finding.id, reviewId: next.id, snapshotHash: next.snapshotHash }),
    };
  }
}
