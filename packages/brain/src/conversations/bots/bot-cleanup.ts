import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveSessionFile } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import {
  type BotCleanupJob,
  BotCleanupRepo,
  BotsRepo,
  CodeMapRepo,
  resolveAttachmentPath,
  transaction,
  WorkplacesRepo,
} from "@pibot/storage";
import { forgetUnusedCodeMapPaths } from "../../runtime/review/code-map-cleanup.ts";

async function exists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function cleanBotFiles(dataDir: string, job: BotCleanupJob, signal: AbortSignal) {
  signal.throwIfAborted();
  const root = await realpath(dataDir),
    bots = join(root, "bots"),
    bot = join(bots, job.botId);
  for (const path of [bots, bot]) {
    const stat = await exists(path);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(path)) !== path))
      throw new TypeError("Unsafe cleanup root");
  }
  // macOS /tmp aliases /private/tmp; accept either app data-root spelling, never another Bot.
  const storedBot = join(resolve(dataDir), "bots", job.botId);
  const sessions = new Set([join(bot, "sessions"), join(storedBot, "sessions")]),
    attachments = new Set([join(bot, "attachments"), join(storedBot, "attachments")]);
  for (const stored of job.sessionFiles) {
    const file = resolveSessionFile(dataDir, stored);
    if (!sessions.has(resolve(dirname(file))) || !file.endsWith(".jsonl"))
      throw new TypeError("Unsafe session cleanup path");
  }
  // Stored values are relative; jobs queued before that change still hold absolute paths.
  const owned = (stored: string) =>
    attachments.has(resolve(dirname(resolveAttachmentPath(dataDir, stored))));
  for (const item of job.attachments)
    if (item.botId !== job.botId || !owned(item.path) || (item.textPath && !owned(item.textPath)))
      throw new TypeError("Unsafe attachment cleanup path");
  for (const path of job.attachmentPaths)
    if (!owned(path)) throw new TypeError("Unsafe attachment cleanup path");
  // Only this app-owned Bot directory; rm removes child symlinks without following them.
  // Recursive deletion covers home, session JSONL, attachment copies and derived PDF pages.
  signal.throwIfAborted();
  await rm(bot, { recursive: true, force: true, maxRetries: 2 });
}
export class BotCleanupService {
  private readonly jobs: BotCleanupRepo;
  private readonly bots: BotsRepo;
  private readonly workplaces: WorkplacesRepo;
  private readonly codeMaps: CodeMapRepo;
  private readonly shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private paused = false;
  async pause() {
    this.paused = true;
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.initial);
    this.initial = undefined;
    await this.pending;
  }
  resume() {
    this.paused = false;
    this.start();
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly logger: Logger,
  ) {
    this.jobs = new BotCleanupRepo(db);
    this.bots = new BotsRepo(db);
    // Retention deletes Bots unattended, so this path owns its repos instead of the
    // code map service, which is created later during local-service assembly.
    this.workplaces = new WorkplacesRepo(db, dataDir);
    this.codeMaps = new CodeMapRepo(db);
  }
  start() {
    if (this.timer || this.paused || this.shutdown.signal.aborted) return;
    const launch = () => {
      void this.sweep().catch(() => {
        if (!this.shutdown.signal.aborted) this.logger.error("Bot cleanup sweep failed");
      });
    };
    // A scheduled first sweep cannot delay brain ready or the desktop startup watchdog.
    this.timer = setInterval(launch, 3_600_000);
    this.timer.unref();
    this.initial = setTimeout(() => {
      this.initial = undefined;
      launch();
    }, 0);
    this.initial.unref();
  }
  private initial?: ReturnType<typeof setTimeout>;
  sweep(now = new Date()) {
    this.pending ??= this.perform(now).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async perform(now: Date) {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20_000)]);
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
    let before: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      const page = this.bots.archivedBefore(cutoff, { before, limit: 50 });
      for (const bot of page) {
        signal.throwIfAborted();
        try {
          const folderPaths = this.workplaces.pathsForBot(bot.id);
          transaction(this.db, () => {
            const manifest = this.bots.purgeArchived(bot.id, now);
            if (manifest) this.jobs.enqueue(bot.id, manifest);
          });
          forgetUnusedCodeMapPaths(
            { codeMap: this.codeMaps, workplaces: this.workplaces },
            this.logger,
            folderPaths,
          );
        } catch (error) {
          if (error instanceof TypeError && error.message === "Archived Bot still belongs to group")
            continue;
          throw error;
        }
      }
      if (page.length < 50) break;
      before = page.at(-1)?.id;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    before = undefined;
    for (;;) {
      signal.throwIfAborted();
      const page = this.jobs.page(before);
      for (const job of page) {
        signal.throwIfAborted();
        try {
          await cleanBotFiles(this.dataDir, job, signal);
          this.jobs.complete(job.botId);
        } catch {
          if (signal.aborted) throw signal.reason;
          this.logger.warn(`Bot cleanup deferred bot=${job.botId}`);
        }
      }
      if (page.length < 50) break;
      before = page.at(-1)?.botId;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  async stop() {
    clearInterval(this.timer);
    clearTimeout(this.initial);
    this.shutdown.abort();
    await this.pending?.catch(() => {
      /* Cancelled sweep keeps durable jobs for the next start. */
    });
  }
}
