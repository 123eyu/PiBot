import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocalToolResult } from "@pibot/agent";
import { semanticHash } from "@pibot/execution/semantic";
import { containsPath } from "@pibot/policy";
import {
  type ComputerStep,
  type DeliveryEvidence,
  DeliveryEvidenceInputSchema,
  RpcError,
} from "@pibot/protocol-base";
import { ComputerStepsRepo, DeliveryEvidenceRepo, RunsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import type { ReviewExecutionService } from "./review-execution-service.ts";

type Scope = { botId: string; conversationId: string };
const terminal = new Set(["done", "error", "aborted", "denied"]);
export class DeliveryEvidenceService {
  readonly repo: DeliveryEvidenceRepo;
  private reviews?: ReviewExecutionService;
  constructor(private readonly local: LocalService) {
    this.repo = new DeliveryEvidenceRepo(local.deps.db);
  }
  attachReviews(reviews: ReviewExecutionService) {
    this.reviews = reviews;
  }
  private observe(context: ToolRunContext, evidence: DeliveryEvidence, sourceId: string) {
    const saved = this.repo.create(evidence, sourceId);
    this.local.deps.peer.emit("delivery.evidence.changed", {
      botId: saved.botId,
      conversationId: saved.conversationId,
      id: saved.id,
    });
    this.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "delivery.evidence",
      summary: "Delivery observation recorded",
      detail: { internal: true, toolName: "delivery_evidence", reasonCode: saved.kind },
    });
  }
  private observationBase(context: ToolRunContext) {
    const source = this.local.tasks.source(context);
    if (!source.conversationId) return undefined;
    return {
      id: randomUUID(),
      botId: context.botId,
      conversationId: source.conversationId,
      rootRunId: this.local.budgets.root(context),
      createdAt: new Date().toISOString(),
      codeHash: null,
    };
  }
  observeTool(context: ToolRunContext, recordId: string): void {
    const tool = this.local.tools.get(recordId),
      source = this.repo.toolRun(recordId);
    if (tool?.tool !== "run_command" || !terminal.has(tool.status)) return;
    const base = this.observationBase(context);
    if (!base || !source || source.botId !== base.botId)
      throw new RpcError(-32602, "evidence_source_invalid");
    const run = this.run(context, source.runId);
    this.observe(
      context,
      {
        ...base,
        runId: run.id,
        kind: "command",
        toolRecordId: recordId,
        toolCallId: tool.toolCallId,
        toolStatus: tool.status,
        exitCode: tool.exitCode,
        durationMs: tool.durationMs,
        finishedAt: tool.finishedAt,
        logAvailable: !!tool.logPath,
      },
      recordId,
    );
  }
  observeStep(context: ToolRunContext, receipt: ComputerStep): void {
    const step = new ComputerStepsRepo(this.local.deps.db).get(receipt.id);
    if (!step?.hasScreenshot) return;
    const base = this.observationBase(context);
    if (
      !base ||
      step.botId !== context.botId ||
      step.runId !== receipt.runId ||
      step.botId !== receipt.botId
    )
      throw new RpcError(-32602, "evidence_source_invalid");
    this.run(context, step.runId);
    this.observe(
      context,
      {
        ...base,
        runId: step.runId,
        kind: "screenshot",
        computerStepId: step.id,
        available: true,
        capturedAt: step.createdAt,
      },
      step.id,
    );
  }
  private scope(scope: Scope) {
    this.local.execution.get(scope);
    return scope;
  }
  private run(context: ToolRunContext, id: string) {
    const root = this.local.budgets.root(context),
      run = new RunsRepo(this.local.deps.db).get(id);
    const task = this.local.tasks.tasks.forRun(id);
    // Group-plan members share the coordinator's budget root but are not internal task_instances.
    // The trusted current run is still eligible; other runs retain the original tree check.
    if (
      !run ||
      run.botId !== context.botId ||
      (id !== context.runId && id !== root && task?.rootRunId !== root)
    )
      throw new RpcError(-32602, "evidence_source_invalid");
    return run;
  }
  private async exists(path: string | undefined) {
    if (
      !path ||
      !containsPath(resolve(this.local.deps.dataDir), resolve(path), this.local.deps.platform)
    )
      return false;
    try {
      const stat = await lstat(path);
      return stat.isFile() && !stat.isSymbolicLink() && (await realpath(path)) === resolve(path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code))
      )
        return false;
      throw error;
    }
  }
  private async screenshot(id: string, runId: string, botId: string) {
    const repo = new ComputerStepsRepo(this.local.deps.db),
      step = repo.get(id),
      stored = repo.screenshotPath(id);
    if (!step || step.runId !== runId || step.botId !== botId)
      throw new RpcError(-32602, "evidence_source_invalid");
    return {
      step,
      available:
        !!stored &&
        stored.botId === botId &&
        (await this.exists(join(this.local.deps.dataDir, "bots", botId, stored.path))),
    };
  }
  async execute(
    context: ToolRunContext,
    input: unknown,
    signal: AbortSignal,
  ): Promise<LocalToolResult> {
    const args = DeliveryEvidenceInputSchema.parse(input),
      source = this.local.tasks.source(context);
    if (!source.conversationId) throw new RpcError(-32602, "evidence_scope_invalid");
    this.local.tasks.guardSync(context);
    this.scope({ botId: source.botId, conversationId: source.conversationId });
    const base = {
      botId: context.botId,
      conversationId: source.conversationId,
      rootRunId: this.local.budgets.root(context),
      createdAt: new Date().toISOString(),
      codeHash: null,
    };
    const entries: { evidence: DeliveryEvidence; sourceId: string }[] = [];
    for (const id of args.toolRecordIds ?? []) {
      signal.throwIfAborted();
      const tool = this.local.tools.get(id),
        message = this.repo.toolRun(id);
      if (
        !tool ||
        !message?.runId ||
        message.botId !== base.botId ||
        !terminal.has(tool.status) ||
        tool.tool !== "run_command"
      )
        throw new RpcError(-32602, "evidence_source_invalid");
      const run = this.run(context, message.runId);
      entries.push({
        sourceId: id,
        evidence: {
          ...base,
          id: randomUUID(),
          runId: run.id,
          kind: "command",
          toolRecordId: id,
          toolCallId: tool.toolCallId,
          toolStatus: tool.status,
          exitCode: tool.exitCode,
          durationMs: tool.durationMs,
          finishedAt: tool.finishedAt,
          logAvailable: await this.exists(tool.logPath ?? undefined),
        },
      });
    }
    for (const id of args.computerStepIds ?? []) {
      signal.throwIfAborted();
      const step = new ComputerStepsRepo(this.local.deps.db).get(id);
      if (!step) throw new RpcError(-32602, "evidence_source_invalid");
      this.run(context, step.runId);
      const actual = await this.screenshot(id, step.runId, context.botId);
      entries.push({
        sourceId: id,
        evidence: {
          ...base,
          id: randomUUID(),
          runId: step.runId,
          kind: "screenshot",
          computerStepId: id,
          available: actual.available,
          capturedAt: step.createdAt,
        },
      });
    }
    for (const id of args.reviewIds ?? []) {
      signal.throwIfAborted();
      if (!this.reviews) throw new RpcError(-32602, "review_unavailable");
      const review = await this.reviews.get(
        { botId: context.botId, conversationId: source.conversationId },
        id,
        signal,
      );
      if (review.rootRunId !== base.rootRunId)
        throw new RpcError(-32602, "evidence_source_invalid");
      entries.push({
        sourceId: id,
        evidence: {
          ...base,
          id: randomUUID(),
          runId: review.reviewerRunId ?? review.parentRunId,
          kind: "review",
          review,
        },
      });
    }
    for (const label of args.unverified ?? []) {
      const safe = this.local.deps.redactor.redact(label).slice(0, 500);
      entries.push({
        sourceId: semanticHash(safe),
        evidence: {
          ...base,
          id: randomUUID(),
          runId: context.runId,
          kind: "unverified",
          label: safe,
          source: "agent",
        },
      });
    }
    this.local.tasks.guardSync(context);
    signal.throwIfAborted();
    const saved = entries.map(({ evidence, sourceId }) => this.repo.create(evidence, sourceId));
    for (const entry of saved)
      this.local.deps.peer.emit("delivery.evidence.changed", {
        botId: entry.botId,
        conversationId: entry.conversationId,
        id: entry.id,
      });
    this.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "delivery.evidence",
      summary: "Delivery evidence attached",
      detail: { internal: true, toolName: "delivery_evidence", itemCount: saved.length },
    });
    return {
      text: JSON.stringify({
        items: saved,
        notice:
          "Evidence records observations, not an overall PASS. Unbound code versions remain unverified.",
      }),
    };
  }
  async get(scope: Scope, id: string, signal: AbortSignal) {
    this.scope(scope);
    signal.throwIfAborted();
    const value = this.repo.get(id);
    if (!value || value.botId !== scope.botId || value.conversationId !== scope.conversationId)
      throw new RpcError(-32602, "evidence_unavailable");
    if (value.kind === "screenshot")
      return {
        ...value,
        available: (await this.screenshot(value.computerStepId, value.runId, value.botId))
          .available,
      };
    if (value.kind === "command") {
      const tool = this.local.tools.get(value.toolRecordId);
      return { ...value, logAvailable: await this.exists(tool?.logPath ?? undefined) };
    }
    if (value.kind === "review" && this.reviews)
      return { ...value, review: await this.reviews.get(scope, value.review.id, signal) };
    return value;
  }
  async list(scope: Scope, page: { before?: string; limit?: number }, signal: AbortSignal) {
    this.scope(scope);
    signal.throwIfAborted();
    const items = this.repo.list(scope, page);
    // Avoid N project scans on list: review freshness is checked only on explicit details.
    return {
      items: items.map((v) =>
        v.kind === "review" ? { ...v, review: { ...v.review, freshness: "checking" as const } } : v,
      ),
      next: items.length === (page.limit ?? 20) ? (items.at(-1)?.id ?? null) : null,
    };
  }
}
