import type { DatabaseSync } from "node:sqlite";
import type { MemoryDraftRequest, MemoryDraftUsage } from "@pibot/agent";
import type { BrainRedactor } from "@pibot/brain/kit";
import {
  AuditRepo,
  BackgroundTaskHealthRepo,
  BotsRepo,
  type MemoryExtraction,
  MemoryExtractionsRepo,
  memoryMaintenanceUsage,
  SettingsRepo,
} from "@pibot/storage";
import {
  extractionPrompt,
  extractionSource,
  groupExtractionInstruction,
} from "./memory-extraction.ts";
import { applyExtractionCandidates, extractionErrorCode } from "./memory-extraction-result.ts";
import type { MemoryService } from "./memory-service.ts";

interface Model {
  provider: string;
  id: string;
}
interface Deps {
  db: DatabaseSync;
  redactor: BrainRedactor;
  logger: { warn(message: string): void; info?(message: string): void };
  memory: MemoryService;
  healthChanged?(): void;
  isIdle(): boolean;
  isBotIdle(botId: string): boolean;
  onBotWork(listener: (botId: string) => void): () => void;
  draftMemories?: (
    request: MemoryDraftRequest,
  ) => Promise<{ draft: unknown; tokens: number; costUsd?: number }>;
}
const TOPICS_PER_BOT_DAY = 20;
const SCAN_MS = 60_000;
function dayStart(now = new Date()): string {
  const value = new Date(now);
  value.setHours(0, 0, 0, 0);
  return value.toISOString();
}

/** One durable worker, yielding to its owning Bot and sharing the unchanged organization caps. */
export class MemoryExtractionQueue {
  private readonly repo: MemoryExtractionsRepo;
  private readonly bots: BotsRepo;
  private readonly settings: SettingsRepo;
  private readonly health: BackgroundTaskHealthRepo;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private busy = false;
  private activeBot: string | undefined;
  private releaseWork: (() => void) | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly deps: Deps) {
    this.repo = new MemoryExtractionsRepo(deps.db);
    this.bots = new BotsRepo(deps.db);
    this.settings = new SettingsRepo(deps.db);
    this.health = new BackgroundTaskHealthRepo(deps.db, deps.healthChanged);
  }
  start() {
    this.repo.recover();
    this.stopped = false;
    this.releaseWork = this.deps.onBotWork((botId) => {
      if (botId === this.activeBot) this.controller?.abort();
    });
    this.schedule(5_000);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.releaseWork?.();
    this.releaseWork = undefined;
    this.controller?.abort();
    await this.running;
  }
  usage(since: string) {
    return memoryMaintenanceUsage(this.deps.db, since);
  }
  idle() {
    return !this.busy;
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delay);
    this.timer.unref?.();
  }
  private async tick() {
    try {
      await this.drain();
    } catch (error) {
      this.warn("memory_extraction_tick_failed", error);
    }
    this.schedule(SCAN_MS);
  }
  enqueueDue() {
    const now = new Date();
    const idleBefore = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const retryAfter = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    let count = 0;
    for (const topic of this.repo.dueTopics(idleBefore, retryAfter, dayStart(now))) {
      if (this.repo.enqueue({ ...topic, reason: topic.lastAt <= idleBefore ? "idle" : "archive" }))
        count++;
      const automated = this.repo.automatedReason(topic.conversationId);
      if (automated) this.repo.skipQueued(topic.conversationId, automated, topic.lastMessageId);
    }
    return count;
  }
  private async drain() {
    if (this.busy || this.stopped || !this.deps.isIdle()) return;
    this.busy = true;
    const excluded = new Set<string>();
    try {
      this.enqueueDue();
      while (!this.stopped && this.deps.isIdle()) {
        const used = this.usage(dayStart());
        const limit = this.limit();
        if (used.costUsd >= limit.costUsd || used.tokens >= limit.tokens) break;
        for (const [id, n] of this.repo.todayByBot(dayStart()))
          if (n >= TOPICS_PER_BOT_DAY) excluded.add(id);
        const next = this.repo.claim([...excluded]);
        if (!next) break;
        const automated = this.repo.automatedReason(next.conversationId);
        if (automated) {
          this.repo.finish(next.id, {
            status: "skipped",
            error: automated,
            coverageMessageId: this.repo.watermark(next.conversationId)?.messageId,
          });
          continue;
        }
        if (!this.deps.isBotIdle(next.botId)) {
          this.repo.defer(next, "bot_busy");
          excluded.add(next.botId);
          continue;
        }
        this.activeBot = next.botId;
        this.controller = new AbortController();
        await this.process(next);
        if (
          this.controller.signal.aborted ||
          this.deps.db
            .prepare(
              "SELECT 1 FROM memory_extractions WHERE conversation_id=? AND status='queued' AND error='budget_exhausted'",
            )
            .get(next.conversationId)
        )
          excluded.add(next.botId);
        this.activeBot = undefined;
        this.controller = undefined;
        // Yield between paid calls; no artificial minute-long pause per topic. The durable caps
        // and one outstanding request bound burst size, while foreground work can preempt it.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.busy = false;
      this.activeBot = undefined;
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
  /**
   * The model this Bot actually chats with: its own, else the default it follows. The auxiliary
   * model setting is tried first inside draftMemories, which falls back to this one. Preferring
   * the default here made every Bot's extraction fail with no_model once the default became
   * unusable (maintainers 2026-11-15: default on the official ChatGPT plan OpenAI refuses, while Pi ran
   * fine on the Codex sign-in), and the inbox filled with failure cards.
   */
  private model(botId: string): Model | undefined {
    const bot = this.bots.get(botId);
    // An image Bot's own model only draws (e.g. seedream), so it is never among the text models
    // extraction can run on and every attempt failed with no_model (maintainers 2026-11-18, 小图). It
    // uses the default model its sibling Bots chat with instead.
    if (bot?.imageMode) return this.settings.get().defaultModel ?? undefined;
    return bot?.modelProvider && bot.modelId
      ? { provider: bot.modelProvider, id: bot.modelId }
      : (this.settings.get().defaultModel ?? undefined);
  }
  private permitted(row: MemoryExtraction): boolean {
    const bot = this.bots.get(row.botId);
    // An external agent keeps its own memory; its chats never go to Pi Bot's model.
    if (!bot || bot.archivedAt || !bot.memoryExtraction || bot.kind === "agent") return false;
    const topic = this.deps.db
      .prepare(`SELECT bot_id,group_id FROM conversations WHERE id=?`)
      .get(row.conversationId);
    if (!topic || topic.group_id !== row.groupId) return false;
    return row.groupId
      ? !!this.deps.db
          .prepare(
            `SELECT 1 FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.group_id=? AND gm.bot_id=? AND gm.left_at IS NULL AND g.coordinator_bot_id=? AND g.archived_at IS NULL`,
          )
          .get(row.groupId, row.botId, row.botId)
      : topic.bot_id === row.botId;
  }
  private async process(row: MemoryExtraction) {
    const skip = (error: string, coverageMessageId?: string) =>
      this.repo.finish(row.id, { status: "skipped", error, coverageMessageId });
    if (!this.permitted(row)) {
      skip("extraction_disabled_or_scope_changed");
      return;
    }
    const automated = this.repo.automatedReason(row.conversationId);
    if (automated) {
      skip(automated, this.repo.watermark(row.conversationId)?.messageId);
      return;
    }
    const prior = this.deps.db
      .prepare(
        `SELECT coverage_message_id AS id FROM memory_extractions WHERE conversation_id=? AND status='done' AND coverage_message_id IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(row.conversationId);
    const source = extractionSource(
      this.deps.db,
      row.conversationId,
      prior?.id == null ? null : String(prior.id),
      12_000,
      row.groupId ?? undefined,
    );
    if (!source) {
      skip("no_new_human_content");
      return;
    }
    const model = this.model(row.botId);
    const draftMemories = this.deps.draftMemories;
    if (!model || !draftMemories) {
      // A missing model used to be silent forever; a streak makes the inbox say it.
      this.health.fail("memory_extraction", row.botId, "no_model");
      skip("no_model");
      return;
    }
    const controller = this.controller;
    if (!controller) throw new Error("extraction_controller_missing");
    try {
      const text = this.deps.redactor.redact(
        extractionPrompt(
          this.deps.memory.extractionCatalog(row.botId, row.groupId),
          source.text,
          source.truncated,
        ),
      );
      const used = this.usage(dayStart());
      const limit = this.limit();
      const draft = (chosen: Model) =>
        draftMemories({
          model: chosen,
          text,
          ...(row.groupId ? { instruction: groupExtractionInstruction() } : {}),
          signal: controller.signal,
          budget: {
            tokens: Math.max(0, limit.tokens - used.tokens),
            costUsd: Math.max(0, limit.costUsd - used.costUsd),
          },
          onUsage: (usage: MemoryDraftUsage) => this.repo.recordUsage(row.id, usage),
        });
      // The Bot's own model may be gone or its key invalid while the main model in Settings still
      // works; one retry there keeps the job alive (maintainers 2026-11-18). Both fail before any
      // request is dispatched, so nothing is billed twice.
      const fallback = this.settings.get().defaultModel ?? undefined;
      const result = await draft(model).catch((error: unknown) => {
        const code = extractionErrorCode(error);
        if (
          (code !== "no_model" && code !== "auth_failed") ||
          !fallback ||
          (fallback.provider === model.provider && fallback.id === model.id) ||
          controller.signal.aborted
        )
          throw error;
        return draft({ provider: fallback.provider, id: fallback.id });
      });
      controller.signal.throwIfAborted();
      if (!this.deps.isBotIdle(row.botId)) {
        this.repo.defer(row, "bot_busy");
        return;
      }
      if (!this.permitted(row)) {
        skip("extraction_disabled_or_scope_changed");
        return;
      }
      if (this.repo.watermark(row.conversationId)?.messageId !== source.watermarkId) {
        this.repo.defer(row, "source_changed");
        return;
      }
      const counts = applyExtractionCandidates(
        this.deps.memory,
        row,
        source.subjectMessageId,
        result.draft,
        source.groupSourceIds,
        source.groupSourceTexts,
      );
      this.repo.diagnostics(row.id, counts);
      const accepted = counts.applied + counts.proposed;
      this.deps.logger.info?.(
        JSON.stringify({
          module: "memory",
          reasonCode: "extraction_result",
          botId: row.botId,
          extractionId: row.id,
          ...counts,
        }),
      );
      this.audit(row, source.messageCount, accepted);
      const failed = counts.raw && !accepted && !counts.reasons.candidate_duplicate;
      this.repo.finish(row.id, {
        status: failed ? "failed" : "done",
        coverageMessageId: source.watermarkId,
        tokens: result.tokens,
        costUsd: result.costUsd,
        candidates: accepted,
        error: !counts.raw
          ? "no_candidates"
          : !counts.valid
            ? "candidates_invalid"
            : !accepted
              ? "candidates_not_applied"
              : null,
      });
      // Wanted repeated zero results noticed, but "nothing worth remembering" is the normal
      // outcome of short task chats (run a command, make a page): as a card it told users to check
      // their models and keys for a working job (v0.0.2 test, 2026-11-14). It stays in the log line
      // above; only invalid or unapplied candidates, a real fault, count against health.
      if (failed)
        this.health.fail(
          "memory_extraction",
          row.botId,
          !counts.valid ? "candidates_invalid" : "candidates_not_applied",
        );
      else this.health.recover("memory_extraction", row.botId);
    } catch (error) {
      const code = extractionErrorCode(error);
      if (this.controller?.signal.aborted) {
        this.repo.defer(row, this.stopped ? "worker_stopped" : "bot_preempted");
        return;
      }
      if (code === "budget_exhausted") {
        this.repo.defer(row, code);
        return;
      }
      if (code === "no_model" || code === "auth_failed") {
        this.health.fail("memory_extraction", row.botId, code);
        skip(code);
        return;
      }
      this.warn("memory_extraction_failed", error);
      this.health.fail("memory_extraction", row.botId, code);
      this.repo.finish(row.id, { status: "failed", error: code });
    }
  }
  private audit(row: MemoryExtraction, messages: number, applied: number) {
    new AuditRepo(this.deps.db, this.deps.redactor).append({
      botId: row.botId,
      kind: "memory.changed",
      summary: "Memory extracted automatically / 自动提炼记忆",
      detail: {
        actor: "automatic",
        reasonCode: "memory_extracted",
        conversationId: row.conversationId,
        messageCount: Math.min(messages, 50),
        ...(row.groupId ? { groupId: row.groupId } : {}),
        revision: applied,
      },
    });
  }
  private warn(reasonCode: string, error: unknown) {
    this.deps.logger.warn(
      JSON.stringify({ module: "memory", reasonCode, error: extractionErrorCode(error) }),
    );
  }
}
