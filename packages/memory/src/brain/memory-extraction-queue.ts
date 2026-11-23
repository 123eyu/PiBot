// Owns the durable extraction worker and yields to foreground Bot work.
import {
  boundaryTopics,
  correctionTopic,
  MemoryExtractionsRepo,
  memoryMaintenanceUsage,
} from "@pibot/storage";
import {
  dayStart,
  MemoryExtractionAttempt,
  type MemoryExtractionAttemptDeps,
} from "./memory-extraction-attempt.ts";
import { extractionErrorCode } from "./memory-extraction-result.ts";

interface Deps extends Omit<MemoryExtractionAttemptDeps, "isPaused"> {
  isIdle(): boolean;
  onBotWork(listener: (botId: string) => void): () => void;
}
const TOPICS_PER_BOT_DAY = 20;
const SCAN_MS = 15_000;
const FALLBACK_SCAN_MS = 60_000;

/** One durable worker, yielding to its owning Bot and sharing the unchanged organization caps. */
export class MemoryExtractionQueue {
  private readonly repo: MemoryExtractionsRepo;
  private readonly attempt: MemoryExtractionAttempt;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private paused = false;
  private nextScan = 0;
  private nextFallback = 0;
  private busy = false;
  private activeBot: string | undefined;
  private releaseWork: (() => void) | undefined;
  private running: Promise<void> | undefined;
  private exitSave: Promise<void> | undefined;
  constructor(private readonly deps: Deps) {
    this.repo = new MemoryExtractionsRepo(deps.db);
    this.attempt = new MemoryExtractionAttempt(
      { ...deps, isPaused: () => this.stopped || this.paused },
      this.repo,
    );
  }
  start() {
    this.repo.recover();
    this.stopped = false;
    this.paused = false;
    this.nextScan = 0;
    this.nextFallback = 0;
    this.releaseWork = this.deps.onBotWork((botId) => {
      if (botId === this.activeBot) this.controller?.abort();
    });
    this.schedule(5_000);
  }
  pause() {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  saveOnExit() {
    this.pause();
    this.exitSave ??= this.persistExitTopics()
      .catch((error: unknown) => {
        this.warn("memory_extraction_exit_failed", error);
      })
      .finally(() => {
        this.exitSave = undefined;
      });
    return this.exitSave;
  }
  private async persistExitTopics() {
    await this.running;
    const at = new Date().toISOString();
    let after = "";
    for (;;) {
      const page = boundaryTopics(this.deps.db, { at, before: at, after, exit: true });
      for (const topic of page) this.repo.enqueue({ ...topic, reason: "boundary" }, at);
      const last = page.at(-1);
      if (!last || page.length < 100) break;
      after = last.conversationId;
      // Large histories must not monopolize the brain's event loop during shutdown.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  resume() {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    this.nextScan = 0;
    this.wake();
  }
  async stop() {
    this.stopped = true;
    this.releaseWork?.();
    this.releaseWork = undefined;
    this.pause();
    await this.running;
    await this.exitSave;
  }
  boundary(conversationId: string) {
    try {
      if (this.stopped) return;
      const at = new Date().toISOString();
      const [topic] = boundaryTopics(this.deps.db, { at, before: at, conversationId });
      if (topic && this.repo.enqueue({ ...topic, reason: "boundary" }, at)) this.wake();
    } catch (error) {
      this.warn("memory_extraction_boundary_failed", error);
    }
  }
  correction(conversationId: string, sourceMessageId: string) {
    try {
      if (this.stopped) return;
      const topic = correctionTopic(this.deps.db, conversationId, sourceMessageId);
      if (topic && this.repo.enqueue({ ...topic, reason: "correction" })) this.wake();
    } catch (error) {
      this.warn("memory_extraction_correction_failed", error);
    }
  }
  private wake() {
    if (!this.running) this.schedule(0);
  }
  usage(since: string) {
    return memoryMaintenanceUsage(this.deps.db, since);
  }
  idle() {
    return !this.busy;
  }
  private schedule(delay: number) {
    if (this.stopped || this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
        this.schedule(SCAN_MS);
      });
    }, delay);
    this.timer.unref?.();
  }
  private async tick() {
    try {
      await this.drain();
    } catch (error) {
      this.warn("memory_extraction_tick_failed", error);
    }
  }
  private scan() {
    const now = Date.now();
    if (now >= this.nextFallback) {
      this.nextFallback = now + FALLBACK_SCAN_MS;
      this.enqueueDue();
    }
    if (now < this.nextScan) return;
    this.nextScan = now + SCAN_MS;
    const at = new Date(now).toISOString();
    const before = new Date(now - 30 * 60_000).toISOString();
    for (const topic of boundaryTopics(this.deps.db, { at, before }))
      this.repo.enqueue({ ...topic, reason: "boundary" }, at);
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
    if (this.busy || this.stopped || this.paused || !this.deps.isIdle()) return;
    this.busy = true;
    const excluded = new Set<string>();
    try {
      while (!this.stopped && !this.paused && this.deps.isIdle()) {
        this.scan();
        const used = this.usage(dayStart());
        const limit = this.attempt.limit();
        if (used.costUsd >= limit.costUsd || used.tokens >= limit.tokens) break;
        for (const [id, n] of this.repo.todayByBot(dayStart()))
          if (n >= TOPICS_PER_BOT_DAY) excluded.add(id);
        const next = this.repo.claim([...excluded]);
        if (!next) break;
        if (!this.deps.isBotIdle(next.botId)) {
          this.repo.defer(next, "bot_busy");
          excluded.add(next.botId);
          continue;
        }
        this.activeBot = next.botId;
        this.controller = new AbortController();
        await this.attempt.process(next, this.controller.signal);
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
  private warn(reasonCode: string, error: unknown) {
    this.deps.logger.warn(
      JSON.stringify({ module: "memory", reasonCode, error: extractionErrorCode(error) }),
    );
  }
}
