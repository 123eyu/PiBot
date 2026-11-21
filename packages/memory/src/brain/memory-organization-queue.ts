import type { DatabaseSync } from "node:sqlite";
import type { MemoryDraftRequest, MemoryDraftUsage } from "@pibot/agent";
import type { BrainRedactor } from "@pibot/brain/kit";
import { RpcError } from "@pibot/protocol-base";
import {
  AuditRepo,
  BackgroundTaskHealthRepo,
  BotsRepo,
  type MemoryOrganization,
  MemoryOrganizationsRepo,
  memoryMaintenanceUsage,
  SettingsRepo,
} from "@pibot/storage";
import { organizationInstruction, parseOrganizationDraft } from "./memory-organization.ts";
import { organizationErrorDetails } from "./memory-organization-errors.ts";
import { organizationModel } from "./memory-organization-model.ts";
import { sortUserMemories } from "./memory-scope-sort.ts";
import type { MemoryService } from "./memory-service.ts";

interface Model {
  provider: string;
  id: string;
}

export interface OrganizationDeps {
  db: DatabaseSync;
  redactor: BrainRedactor;
  logger: { warn(message: string): void };
  memory: MemoryService;
  healthChanged?(): void;
  isIdle(): boolean;
  draftMemories?: (request: MemoryDraftRequest) => Promise<{
    draft: unknown;
    tokens: number;
    costUsd?: number;
  }>;
}

/** A Bot's notes are organized at most this often per day, failures included. */
const RUNS_PER_BOT_DAY = 4;
const ORGANIZE_COUNT = 40;
const ORGANIZE_MIN = 8;
const WINDOW_MS = 7 * 86400_000;
const RETRY_MS = 24 * 3600_000;
const SCAN_MS = 5 * 60_000;

function dayStart(now = new Date()): string {
  const value = new Date(now);
  value.setHours(0, 0, 0, 0);
  return value.toISOString();
}

/**
 * The organization worker. It shares the extraction worker's constraints — idle-only, one
 * run at a time, durable across restarts, and the same daily budget — because both spend the same
 * auxiliary-model allowance. It never edits a note: every result is a pending proposal for the user.
 */
export class MemoryOrganizationQueue {
  private readonly repo: MemoryOrganizationsRepo;
  private readonly bots: BotsRepo;
  private readonly settings: SettingsRepo;
  private readonly health: BackgroundTaskHealthRepo;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private busy = false;

  constructor(private readonly deps: OrganizationDeps) {
    this.repo = new MemoryOrganizationsRepo(deps.db);
    this.bots = new BotsRepo(deps.db);
    this.settings = new SettingsRepo(deps.db);
    this.health = new BackgroundTaskHealthRepo(deps.db, deps.healthChanged);
  }

  start() {
    this.repo.recover();
    this.stopped = false;
    this.schedule(90_000);
  }

  private ownerTask: Promise<unknown> | undefined;
  private ownerRunId: string | undefined;

  async sortIntoPlace(
    runId: string,
    signal: AbortSignal,
    progress: Parameters<typeof sortUserMemories>[3],
  ) {
    if (this.busy || this.stopped || !this.deps.isIdle())
      throw new RpcError(-32011, "memory_sort_busy");
    this.busy = true;
    this.controller = new AbortController();
    const combined = AbortSignal.any([
      signal,
      this.controller.signal,
      AbortSignal.timeout(300_000),
    ]);
    this.ownerRunId = runId;
    const task = sortUserMemories(this.deps, runId, combined, progress);
    this.ownerTask = task;
    try {
      return await task;
    } finally {
      this.ownerTask = undefined;
      this.ownerRunId = undefined;
      this.controller = undefined;
      this.busy = false;
    }
  }

  async cancelSortIntoPlace(runId: string) {
    if (this.ownerRunId !== runId) return;
    this.controller?.abort();
    await this.ownerTask;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.ownerTask;
  }

  /** The extraction worker yields to a running organization run, so only one model call is in flight. */
  idle() {
    return !this.busy;
  }

  usage(since: string) {
    return this.repo.usageSince(since);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  private async tick() {
    if (this.stopped) return;
    try {
      await this.drain();
    } catch (error) {
      this.warn("memory_organization_tick_failed", error);
    }
    this.schedule(SCAN_MS);
  }

  /**
   * Both spec branches (over 40 notes, or a week passed with new notes) share the seven-day
   * cooldown: without it a Bot that stays above 40 would call the model on every scan while the
   * user ignores the proposals. A failed attempt retries after a day instead.
   */
  private due(
    reason: {
      activeCount: number;
      lastDoneAt: string | null;
      lastAttemptAt: string | null;
      lastChangedAt: string | null;
    },
    now: number,
  ) {
    if (reason.lastAttemptAt && now - Date.parse(reason.lastAttemptAt) < RETRY_MS) return undefined;
    if (reason.lastDoneAt && now - Date.parse(reason.lastDoneAt) < WINDOW_MS) return undefined;
    if (reason.activeCount > ORGANIZE_COUNT) return "count" as const;
    const changed =
      reason.lastChangedAt !== null &&
      (reason.lastDoneAt === null || reason.lastChangedAt > reason.lastDoneAt);
    return reason.activeCount >= ORGANIZE_MIN && changed ? ("stale" as const) : undefined;
  }

  private enqueueDue() {
    const now = Date.now();
    let count = 0;
    let cursor = "";
    for (;;) {
      const botIds = this.bots.activeIds(cursor);
      for (const botId of botIds) {
        for (const target of this.repo.targets(botId)) {
          const reason = this.due(target, now);
          if (!reason) continue;
          if (this.repo.enqueue({ botId, scope: target.scope, ownerId: target.ownerId, reason }))
            count++;
        }
      }
      if (botIds.length < 100) break;
      cursor = botIds.at(-1) ?? "";
    }
    return count;
  }

  private async drain() {
    if (this.busy || this.stopped || !this.deps.isIdle()) return;
    this.busy = true;
    this.controller = new AbortController();
    try {
      this.enqueueDue();
      while (!this.stopped && this.deps.isIdle()) {
        const limit = this.limit();
        // Extraction and organization draw on the same day budget: whichever cap is reached first
        // stops both, so the configured ceiling is the real spend.
        const used = memoryMaintenanceUsage(this.deps.db, dayStart());
        if (used.costUsd >= limit.costUsd || used.tokens >= limit.tokens) break;
        const counts = this.repo.todayByBot(dayStart());
        const full = [...counts].filter(([, n]) => n >= RUNS_PER_BOT_DAY).map(([id]) => id);
        const next = this.repo.claim(full);
        if (!next) break;
        await this.process(next);
      }
    } finally {
      this.busy = false;
      this.controller = undefined;
    }
  }

  private limit() {
    const settings = this.settings.get();
    return {
      costUsd: settings.memoryExtractionDailyCostUsd ?? 0.5,
      tokens: settings.memoryExtractionDailyTokens ?? 2_000_000,
    };
  }

  private model(botId: string): Model | undefined {
    return organizationModel(this.deps.db, botId);
  }

  private async process(row: MemoryOrganization) {
    const bot = this.bots.get(row.botId);
    if (!bot || bot.archivedAt) {
      this.repo.finish(row.id, { status: "skipped" });
      return;
    }
    const model = this.model(row.botId);
    if (!model || !this.deps.draftMemories) {
      // No usable auxiliary model is a normal state, not a failure: stay quiet and retry later.
      // Keeps the quiet run but counts it: "never organized" was the part nobody saw.
      this.health.fail("memory_organization", row.botId, "no_model");
      this.repo.finish(row.id, { status: "skipped" });
      return;
    }
    let catalog: { text: string; ids: string[] };
    try {
      catalog = this.deps.memory.organizationCatalog(row.botId, row.scope, row.ownerId);
    } catch {
      // The owner disappeared (group left, Bot archived) between enqueue and now.
      this.repo.finish(row.id, { status: "skipped" });
      return;
    }
    if (!catalog.ids.length) {
      this.repo.finish(row.id, { status: "skipped", memoryCount: 0 });
      return;
    }
    try {
      const used = memoryMaintenanceUsage(this.deps.db, dayStart());
      const limit = this.limit();
      const draftMemories = this.deps.draftMemories;
      const signal = this.controller?.signal ?? new AbortController().signal;
      const draft = (chosen: Model) =>
        draftMemories({
          model: chosen,
          text: this.deps.redactor.redact(catalog.text),
          instruction: organizationInstruction(),
          signal,
          budget: {
            tokens: Math.max(0, limit.tokens - used.tokens),
            costUsd: Math.max(0, limit.costUsd - used.costUsd),
          },
          onUsage: (usage: MemoryDraftUsage) => this.repo.recordUsage(row.id, usage),
        });
      // Like extraction: a Bot model that is gone or refused falls back once to the main model in
      // Settings; both fail before dispatch, so nothing is billed twice (maintainers 2026-11-18).
      const fallback = this.settings.get().defaultModel ?? undefined;
      let usedModel = model;
      const result = await draft(model).catch((error: unknown) => {
        const { error: code } = organizationErrorDetails(error);
        if (
          (code !== "no_model" && code !== "auth_failed") ||
          !fallback ||
          (fallback.provider === model.provider && fallback.id === model.id) ||
          signal.aborted
        )
          throw error;
        usedModel = { provider: fallback.provider, id: fallback.id };
        return draft(usedModel);
      });
      const { proposals } = parseOrganizationDraft(result.draft, new Set(catalog.ids));
      let created = 0;
      for (const proposal of proposals) {
        try {
          created += this.deps.memory.applyOrganization(
            row.botId,
            row.scope,
            row.ownerId,
            proposal,
          );
        } catch {
          // One note that vanished or changed under us must not discard the other proposals.
        }
      }
      this.audit(row, usedModel, catalog.ids.length, created);
      this.repo.finish(row.id, {
        status: "done",
        modelProvider: usedModel.provider,
        modelId: usedModel.id,
        tokens: result.tokens,
        costUsd: result.costUsd ?? 0,
        proposals: created,
        memoryCount: catalog.ids.length,
      });
      if (!this.controller?.signal.aborted) this.health.recover("memory_organization", row.botId);
    } catch (error) {
      const { error: code } = organizationErrorDetails(error);
      // Missing model or refused credentials are configuration states; they must not burn the day.
      if (code === "no_model" || code === "auth_failed") {
        if (!this.controller?.signal.aborted)
          this.health.fail("memory_organization", row.botId, code);
        this.repo.finish(row.id, { status: "skipped", memoryCount: catalog.ids.length });
        return;
      }
      this.warn("memory_organization_failed", error);
      if (!this.controller?.signal.aborted)
        this.health.fail("memory_organization", row.botId, code);
      this.repo.finish(row.id, {
        status: "failed",
        memoryCount: catalog.ids.length,
        error: code,
      });
    }
  }

  private audit(row: MemoryOrganization, model: Model, notes: number, proposals: number) {
    // `notes` is not in the audit detail vocabulary on purpose: the row keeps the count, and the
    // audit only needs what happened and how many proposals the user will be asked about.
    void notes;
    new AuditRepo(this.deps.db, this.deps.redactor).append({
      botId: row.botId,
      kind: "memory.changed",
      summary: "Memory organized into proposals / 记忆整理提议已生成",
      detail: {
        actor: "automatic",
        reasonCode: "memory_organized",
        memoryScope: row.scope,
        memoryOwnerId: row.ownerId,
        modelId: model.id,
        revision: proposals,
      },
    });
  }

  private warn(reason: string, error: unknown) {
    this.deps.logger.warn(
      JSON.stringify({
        module: "memory",
        reasonCode: reason,
        ...organizationErrorDetails(error),
      }),
    );
  }
}
