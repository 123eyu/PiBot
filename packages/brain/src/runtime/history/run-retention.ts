import { lstat, opendir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { resolveSessionFile } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import { IdSchema, type RunRetentionResult } from "@pibot/protocol-base";
import { RunRetentionRepo } from "@pibot/storage";
import { z } from "zod";

const manifestSchema = z.strictObject({
  sessionFiles: z.array(z.string()),
  resultFiles: z.array(z.string()),
});
const RESULT_FILE =
  /^run-events\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt)$/i;
const ORPHAN_MIN_AGE_MS = 10 * 60_000;
const ORPHAN_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt(?:\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)?$/i;

/** Explicit, serialized run-history cleanup plus crash recovery for its file manifests. */
export class RunRetention {
  private readonly shutdown = new AbortController();
  private chain: Promise<unknown> = Promise.resolve();
  private active = 0;
  private readonly repo: RunRetentionRepo;

  constructor(
    db: import("node:sqlite").DatabaseSync,
    private readonly dataDir: string,
    private readonly logger: Logger,
  ) {
    this.db = db;
    this.repo = new RunRetentionRepo(db);
  }
  private readonly db: import("node:sqlite").DatabaseSync;

  start() {
    void this.serial(async () => {
      await this.sweepJobs();
      await this.sweepOrphans();
    }).catch(() => {
      if (!this.shutdown.signal.aborted) this.logger.warn("Run file cleanup deferred");
    });
  }

  idle() {
    return this.active === 0;
  }

  pause() {
    return this.chain.then(() => undefined);
  }

  cleanup(olderThanDays: number): Promise<RunRetentionResult> {
    return this.serial(async () => {
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
      const result: RunRetentionResult = {
        runs: 0,
        events: 0,
        executions: 0,
        sessionFiles: 0,
        resultFiles: 0,
      };
      const keys = new Set<string>();
      for (;;) {
        this.shutdown.signal.throwIfAborted();
        const batch = this.repo.cleanupBefore(cutoff);
        result.runs += batch.runs;
        result.events += batch.events;
        result.executions += batch.executions;
        if (batch.cleanupKey) keys.add(batch.cleanupKey);
        if (batch.runs === 0) break;
        await yieldLoop(undefined, { signal: this.shutdown.signal });
      }
      const files = await this.sweepJobs(keys);
      result.sessionFiles += files.sessionFiles;
      result.resultFiles += files.resultFiles;
      result.resultFiles += await this.sweepOrphans();
      return result;
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      this.shutdown.signal.throwIfAborted();
      this.active++;
      try {
        return await operation();
      } finally {
        this.active--;
      }
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async sweepJobs(owned = new Set<string>()) {
    const removed = { sessionFiles: 0, resultFiles: 0 };
    let ownedFailure = false;
    let before = "run-cleanup:";
    for (;;) {
      this.shutdown.signal.throwIfAborted();
      const page = this.db
        .prepare(
          "SELECT key,value FROM settings WHERE key LIKE 'run-cleanup:%' AND key>? ORDER BY key LIMIT 50",
        )
        .all(before);
      for (const row of page) {
        const key = String(row.key);
        try {
          const manifest = manifestSchema.parse(JSON.parse(String(row.value)));
          let sessions = 0,
            results = 0;
          for (const file of manifest.sessionFiles)
            if (!this.repo.sessionReferenced(file) && (await this.removeSession(file))) sessions++;
          for (const file of manifest.resultFiles)
            if (!this.repo.resultReferenced(file) && (await this.removeResult(file))) results++;
          this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
          if (owned.has(key)) {
            removed.sessionFiles += sessions;
            removed.resultFiles += results;
          }
        } catch {
          this.shutdown.signal.throwIfAborted();
          if (owned.has(key)) ownedFailure = true;
          this.logger.warn("Run cleanup job retained for retry");
        }
      }
      if (page.length < 50) break;
      before = String(page.at(-1)?.key);
    }
    if (ownedFailure) throw new Error("Run file cleanup deferred");
    return removed;
  }

  private async removeSession(stored: string): Promise<boolean> {
    const root = await realpath(this.dataDir);
    const file = resolveSessionFile(this.dataDir, stored);
    const botId = IdSchema.parse(basename(dirname(dirname(file))));
    const owned = join(root, "bots", botId, "sessions");
    if (
      ![owned, join(resolve(this.dataDir), "bots", botId, "sessions")].includes(
        resolve(dirname(file)),
      )
    )
      throw new Error("Unsafe run session cleanup path");
    for (const path of [join(root, "bots"), join(root, "bots", botId), owned]) {
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(path)) !== path)
          throw new Error("Unsafe run session cleanup root");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }
    this.shutdown.signal.throwIfAborted();
    if (this.repo.sessionReferenced(stored)) return false;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe run session file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await rm(file);
    return true;
  }

  private async resultDirectory(): Promise<string | undefined> {
    const root = await realpath(this.dataDir);
    const directory = join(root, "run-events");
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
        throw new Error("Unsafe run result directory");
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async removeResult(stored: string): Promise<boolean> {
    const match = RESULT_FILE.exec(stored);
    if (!match) throw new Error("Unsafe run result path");
    const directory = await this.resultDirectory();
    if (!directory) return false;
    const file = join(directory, match[1] as string);
    this.shutdown.signal.throwIfAborted();
    if (this.repo.resultReferenced(stored)) return false;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe run result file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await rm(file);
    return true;
  }

  private async sweepOrphans(): Promise<number> {
    const directory = await this.resultDirectory();
    if (!directory) return 0;
    let removed = 0;
    for await (const entry of await opendir(directory)) {
      this.shutdown.signal.throwIfAborted();
      if (!ORPHAN_FILE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
      const stored = `run-events/${entry.name}`;
      if (!entry.name.endsWith(".tmp") && this.repo.resultReferenced(stored)) continue;
      // A result file is written before the transaction that references it commits (and a .tmp
      // may still be in flight), so only files untouched for a while count as orphans.
      const path = join(directory, entry.name);
      if (Date.now() - (await lstat(path)).mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      await rm(path);
      removed++;
    }
    return removed;
  }

  async stop() {
    this.shutdown.abort();
    await this.chain;
  }
}
