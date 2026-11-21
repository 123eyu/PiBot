import {
  BUDGET_RAISE_SHARE,
  BUDGET_RAISES_MAX,
  type BudgetSnapshot,
  type ChangesTurn,
  MemoryScopeSchema,
  RECEIPT_CHILD_MODELS,
  RECEIPT_UNCERTAIN,
  RECEIPT_UNVERIFIED,
  RpcError,
  RpcErrorCodes,
  type Run,
  type RunReceipt,
  RunReceiptSchema,
} from "@pibot/protocol-base";
import {
  costRaise,
  ExecutionRepo,
  RunReceiptRepo,
  RunRecoveryRepo,
  RunsRepo,
} from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { LocalService } from "../../local-service.ts";
import { TASK_CONTINUATION_PREFIX } from "../continuation/continuation-keys.ts";
import { receiptOutputs, tallyAudit } from "./receipt-tally.ts";

/** A history page asks for one receipt per reply at once; recent ones stay in memory. */
const CACHE_ENTRIES = 200;

/**
 * Work receipt of one run, rebuilt on demand from the app's own records. The model's text
 * is never read: only audit facts, the recorded file changes, approvals, the budget ledger, the
 * plan, delivery evidence and child tasks. Bounded by the contract (top keys, a few files).
 */
export class RunReceiptService {
  private readonly cache = new Map<string, { fingerprint: string; receipt: RunReceipt }>();
  constructor(private readonly local: LocalService) {}

  async get(runId: string, signal: AbortSignal): Promise<RunReceipt> {
    const run = new RunsRepo(this.local.deps.db).get(runId);
    if (!run) throw new RpcError(RpcErrorCodes.invalidParams, "run_not_found");
    const repo = new RunReceiptRepo(this.local.deps.db);
    const root = this.local.tasks.budgetRoot(run);
    // Computed lazily on first view, never at run end; reused until a record it reads changes.
    const planBudget = this.local.collaboration?.planBudgetResume?.(run.id);
    const fingerprint = `${repo.fingerprint(run.id, root) ?? ""}:${!!planBudget && !planBudget.resumedRunId}`;
    const cached = this.cache.get(runId);
    if (cached?.fingerprint === fingerprint) return cached.receipt;
    const receipt = RunReceiptSchema.parse(await this.build(run, root, repo, signal));
    this.cache.delete(runId);
    this.cache.set(runId, { fingerprint, receipt });
    if (this.cache.size > CACHE_ENTRIES)
      this.cache.delete(this.cache.keys().next().value as string);
    return receipt;
  }

  private async build(
    run: Run,
    root: string,
    repo: RunReceiptRepo,
    signal: AbortSignal,
  ): Promise<RunReceipt> {
    const { db } = this.local.deps;
    const auditRows = repo.audit(run.id).rows;
    const totals = tallyAudit(auditRows);
    const turn = await this.turn(run.id, signal);
    const tools = repo.tools(run.id);
    const codeAnalysis = tools.find((tool) => tool.codeAnalysis)?.codeAnalysis;
    const approvals = repo.approvals(run.id);
    const approvalCount = (...statuses: string[]) =>
      approvals.filter((row) => statuses.includes(row.status)).reduce((s, r) => s + r.count, 0);
    const children = repo.childTasks(root, run.id);
    const childCount = (...statuses: string[]) =>
      children.filter((row) => statuses.includes(row.status)).reduce((s, r) => s + r.count, 0);
    const evidence = repo.evidence(root, run.id);
    const unverified = evidence.flatMap((item) => {
      const label = item.kind === "unverified" ? shorten(item.label) : "";
      return item.kind === "unverified" && label ? [{ label, source: item.source }] : [];
    });
    const facts = repo.replyFacts(run.messageId);
    // Snapshot taken when the run ended; older runs fall back to the current plan.
    const current =
      !facts.planAtEnd && repo.updatedPlan(run.id)
        ? new ExecutionRepo(db).todo({ botId: run.botId, conversationId: run.conversationId })
        : undefined;
    const plan = facts.planAtEnd ?? {
      open:
        current?.items.filter((item) => item.status === "pending" || item.status === "in_progress")
          .length ?? 0,
      total: current?.items.length ?? 0,
    };
    const budget = this.local.budgets.repo.get(root);
    const childModels = children.length ? repo.childModels(root, run.id, RECEIPT_CHILD_MODELS) : [];
    const journal = this.local.toolJournal.repo;
    const uncertainTotal = journal.uncertainCount(run.id);
    const priced = budget ? budget.requests - budget.unknownCostRequests : 0;
    const connectorNames = capabilityConnectorNames(repo, totals.connectors.keys());
    return {
      version: 1,
      runId: run.id,
      messageId: run.messageId,
      botId: run.botId,
      conversationId: run.conversationId,
      groupId: run.groupId,
      ...(codeAnalysis ? { codeAnalysis } : {}),
      ...(run.triggerKey?.startsWith("background_finished:")
        ? {
            trigger: "background_finished" as const,
            backgroundCommandId: this.local.background.continuation.commandIds(run)[0],
          }
        : {}),
      source:
        run.kind === "routine" || run.kind === "group_task" || run.kind === "wake"
          ? run.kind
          : repo.isSubtask(run.id)
            ? "subtask"
            : "chat",
      outcome:
        run.status === "done"
          ? facts.executionStall
            ? "stopped"
            : "done"
          : run.status === "error"
            ? "failed"
            : run.status === "aborted"
              ? "stopped"
              : "running",
      reasonCode:
        run.status === "done"
          ? (facts.executionStall?.reason ?? null)
          : (run.errorCode ?? run.stopReason)?.slice(0, 100) || null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      inputs: {
        files: totals.files.buckets(),
        web: totals.web.buckets(),
        searches: totals.searches.buckets(),
        connectors: totals.connectors.rename(connectorNames).buckets(),
        phone: totals.phone.buckets(),
        messages: totals.messages,
        browser: tools
          .filter((tool) => tool.tool.startsWith("browser_") && tool.status === "done")
          .reduce((sum, tool) => sum + tool.count, 0),
      },
      outputs: {
        ...receiptOutputs(turn, totals),
        attachments: totals.attachments,
        images: totals.images,
      },
      approvals: {
        asked: approvals.reduce((sum, row) => sum + row.count, 0),
        allowed: approvalCount("allowed"),
        denied: approvalCount("denied"),
        unanswered: approvalCount("auto_denied", "cancelled", "expired"),
        automatic: tools.reduce((sum, tool) => sum + tool.yolo, 0),
      },
      actions: {
        commands: totals.commands,
        failedCommands: totals.failedCommands,
        sentDrafts: totals.sentDrafts,
        delegated: totals.delegated,
        blocked: totals.blocked,
      },
      cost: budget
        ? {
            shared: repo.sharesBudget(root, run.id, TASK_CONTINUATION_PREFIX),
            requests: budget.requests,
            tokens: Math.round(budget.observedTokens),
            costUsd: priced > 0 || budget.knownCostUsd > 0 ? budget.knownCostUsd : null,
            unknownCostRequests: budget.unknownCostRequests,
            activeMs: Math.round(budget.activeMillis),
            exhaustedReason: budget.exhaustedReason?.slice(0, 100) ?? null,
          }
        : null,
      model: facts.model,
      childTasks: {
        total: children.reduce((sum, row) => sum + row.count, 0),
        done: childCount("done"),
        failed: childCount("error", "aborted", "interrupted"),
        running: childCount("queued", "running", "stopping"),
      },
      evidence: {
        commands: evidence.filter((item) => item.kind === "command").length,
        screenshots: evidence.filter((item) => item.kind === "screenshot").length,
        reviews: evidence.filter((item) => item.kind === "review").length,
      },
      ...(auditRows.some(
        (row) => row.kind === "file.read" && row.detail.reasonCode === "project_notes_changed",
      )
        ? { projectNotesChanged: true }
        : {}),
      unverified: {
        items: unverified.slice(0, RECEIPT_UNVERIFIED),
        total: unverified.length,
        failedCheck: totals.check === "failed" || totals.check === "blocked" ? totals.check : null,
        openTodos: plan.open,
        todoTotal: plan.total,
      },
      ...usedMemories(repo, run.messageId, this.local.deps.redactor),
      ...(facts.outputContinuations ? { outputContinuations: facts.outputContinuations } : {}),
      ...(facts.delivery ? { delivery: facts.delivery } : {}),
      ...(facts.groupExecution ? { groupExecution: facts.groupExecution } : {}),
      ...budgetRaiseOffer(
        run,
        budget,
        () => {
          const workflow = new RunRecoveryRepo(db).get(run.id)?.workflow;
          const ticket = this.local.collaboration?.planBudgetResume?.(run.id);
          // A consumed ticket only answers duplicate requests; it cannot spend another raise.
          return workflow || (ticket?.resumedRunId ? undefined : ticket);
        },
        () => new RunsRepo(db).hasRunAfter(run.id),
        !!this.local.collaboration?.planBudgetResume?.(run.id),
      ),
      ...(childModels.length ? { childModels } : {}),
      ...(uncertainTotal
        ? {
            uncertain: {
              items: journal
                .uncertain(run.id, RECEIPT_UNCERTAIN)
                .map(({ tool, effectClass, createdAt }) => ({ tool, effectClass, createdAt })),
              total: uncertainTotal,
            },
          }
        : {}),
    };
  }

  /** The run's recorded file changes; absent when the workspace capability is not loaded. */
  private async turn(runId: string, signal: AbortSignal): Promise<ChangesTurn | undefined> {
    const changes = this.local.workspaceServices?.changes;
    if (!changes) return undefined;
    try {
      const turn = await changes.turnFiles(runId, signal);
      return turn.runId === runId ? turn : undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      // The audit's written paths still list the files; only the line counts are lost.
      this.local.deps.logger.warn(
        JSON.stringify({ module: "receipt", event: "turn_unavailable", runId }),
      );
      return undefined;
    }
  }
}

/** Adapter calls are counted by stable capability and the concrete connector implementation. */
function capabilityConnectorNames(repo: RunReceiptRepo, keys: readonly string[]) {
  const ids = keys.map((key) => key.split("\0").at(-1) ?? key);
  const names = repo.connectorNames(ids);
  return new Map(
    keys.map((key) => {
      const [capabilityId, connectorId] = key.split("\0");
      return key.includes("\0")
        ? [key, `${capabilityId} · connector:${names.get(connectorId ?? "") ?? "unknown"}`]
        : [key, names.get(key) ?? key];
    }),
  );
}

/**
 * The 「加预算继续」 offer on a workflow run the budget stopped at its cost cap. Not for
 * routines (nobody is there to decide); unavailable once used up or superseded by a newer run.
 */
function usedMemories(
  repo: RunReceiptRepo,
  messageId: string,
  redactor: { redact(text: string): string },
): Pick<RunReceipt, "memories"> {
  const used = repo.usedMemories(messageId, 20);
  if (!used.total) return {};
  return {
    memories: {
      total: used.total,
      items: used.items.map((item) => ({
        id: item.id,
        scope: MemoryScopeSchema.safeParse(item.scope).data ?? null,
        // A deleted note keeps its slot (text null) so the count still matches what was used.
        text: item.text === null ? null : shorten(redactor.redact(item.text)),
      })),
    },
  };
}

function budgetRaiseOffer(
  run: Run,
  budget: BudgetSnapshot | undefined,
  workflow: () => unknown,
  newer: () => boolean,
  abortedPlan = false,
): Pick<RunReceipt, "budgetRaise"> {
  if (
    run.kind === "routine" ||
    !(
      (run.status === "aborted" && abortedPlan) ||
      (run.status === "error" && run.errorCode === "budget_exhausted")
    )
  )
    return {};
  if (budget?.exhaustedReason !== "cost" || budget.limits.costUsd === null) return {};
  if (!workflow()) return {};
  const next = costRaise(budget, BUDGET_RAISE_SHARE, BUDGET_RAISES_MAX);
  const used = budget.costRaises?.count ?? 0;
  if (!next && used < BUDGET_RAISES_MAX) return {};
  const base = budget.costRaises?.baseUsd ?? budget.limits.costUsd;
  return {
    budgetRaise: {
      available: !!next && !newer(),
      capUsd: budget.limits.costUsd,
      raiseUsd:
        next?.amountUsd ?? Math.max(0.01, Math.round(base * BUDGET_RAISE_SHARE * 100) / 100),
      used,
      max: BUDGET_RAISES_MAX,
    },
  };
}

function shorten(label: string) {
  const line = label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return line.length <= 200 ? line : `${line.slice(0, 199).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

export function registerReceiptRpc(handle: KernelRegisterRpc, local: LocalService) {
  const receipts = new RunReceiptService(local);
  handle("runs.receipt", ({ runId }) =>
    receipts.get(runId, AbortSignal.any([local.shutdown.signal, AbortSignal.timeout(20_000)])),
  );
}
