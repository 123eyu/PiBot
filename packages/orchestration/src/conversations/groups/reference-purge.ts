import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { purgeSessionReferences, resolveSessionFile } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import { IdSchema } from "@pibot/protocol-base";
import { groupSessionFiles } from "@pibot/storage";
import { z } from "zod";

const reasons = ["topic_archived", "member_removed", "messages_deleted"] as const;
const jobSchema = z.strictObject({
  groupId: IdSchema,
  botId: IdSchema,
  conversationId: IdSchema.optional(),
  reason: z.enum(reasons),
  files: z.array(z.string()).max(10_000),
  /** Present: only references that showed one of these messages; absent: every reference. */
  messageIds: z.array(z.string().max(200)).max(10_000).optional(),
});
type Job = z.infer<typeof jobSchema>;
const PREFIX = "reference-purge:";

export type PurgeAudit = (job: Job, counts: { files: number; entries: number }) => void;

/**
 * Maintainers 2026-10-23: "save, but purge on delete". Saved group references (persisted
 * reference / update entries in Bots' pi session files) are removed when the content they hold
 * stops being available to that Bot: a group topic archived, a member removed from the group, or
 * group messages deleted. A deleted group or Bot already removes its session files entirely.
 *
 * The job (which files, which messages) is stored in the same database transaction as the change
 * that causes it, and swept right after and on every start until it succeeds, so a crash in
 * between still purges. Each file is rewritten atomically with placeholders
 * (`purgeSessionReferences`), which is idempotent, so a retried job is harmless. Audit and log
 * carry counts only, never content.
 */
export class ReferencePurge {
  private pending?: Promise<void>;
  private readonly shutdown = new AbortController();
  private paused = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly logger: Logger,
    private readonly audit: PurgeAudit,
  ) {}

  /** Call inside the transaction of the change that makes the content unavailable. */
  enqueue(scope: {
    groupId: string;
    botId: string;
    reason: Job["reason"];
    conversationId?: string;
    member?: string;
    messageIds?: string[];
  }) {
    const files = groupSessionFiles(this.db, {
      groupId: scope.groupId,
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      ...(scope.member ? { botId: scope.member } : {}),
    });
    if (!files.length) return;
    const job = jobSchema.parse({
      groupId: scope.groupId,
      botId: scope.member ?? scope.botId,
      reason: scope.reason,
      files,
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      ...(scope.messageIds ? { messageIds: scope.messageIds } : {}),
    });
    this.db
      .prepare("INSERT INTO settings(key,value) VALUES (?,?)")
      .run(`${PREFIX}${randomUUID()}`, JSON.stringify(job));
  }

  sweep() {
    if (this.paused || this.shutdown.signal.aborted) return Promise.resolve();
    this.pending ??= this.perform()
      .catch((error: unknown) => {
        if (!this.shutdown.signal.aborted)
          this.logger.warn(
            JSON.stringify({
              module: "reference-purge",
              event: "deferred",
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  async pause() {
    this.paused = true;
    await this.pending;
  }

  resume() {
    this.paused = false;
    void this.sweep();
  }

  async stop() {
    this.shutdown.abort();
    await this.pending;
  }

  private async perform() {
    let after = PREFIX;
    for (;;) {
      this.shutdown.signal.throwIfAborted();
      const page = this.db
        .prepare(
          "SELECT key,value FROM settings WHERE key LIKE 'reference-purge:%' AND key>? ORDER BY key LIMIT 50",
        )
        .all(after);
      for (const row of page) {
        const key = String(row.key);
        const job = jobSchema.parse(JSON.parse(String(row.value)));
        try {
          let files = 0;
          let entries = 0;
          const match = job.messageIds
            ? { messageIds: new Set(job.messageIds) }
            : { all: true as const };
          for (const stored of job.files) {
            const file = await this.owned(stored);
            if (!file) continue;
            const replaced = await purgeSessionReferences(file, match, this.shutdown.signal);
            if (replaced) files++;
            entries += replaced;
          }
          this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
          this.audit(job, { files, entries });
          this.logger.info(
            JSON.stringify({
              module: "reference-purge",
              event: "purged",
              groupId: job.groupId,
              reason: job.reason,
              files,
              entries,
            }),
          );
        } catch (error) {
          this.shutdown.signal.throwIfAborted();
          this.logger.warn(
            JSON.stringify({
              module: "reference-purge",
              event: "retained",
              groupId: job.groupId,
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
        }
      }
      if (page.length < 50) break;
      after = String(page.at(-1)?.key);
    }
  }

  /** The session file when it is a regular file inside its Bot's sessions folder. */
  private async owned(stored: string) {
    const file = resolveSessionFile(this.dataDir, stored);
    const botId = IdSchema.parse(basename(dirname(dirname(file))));
    const root = await realpath(this.dataDir);
    const folder = join(root, "bots", botId, "sessions");
    if (
      !file.endsWith(".jsonl") ||
      ![folder, join(resolve(this.dataDir), "bots", botId, "sessions")].includes(
        resolve(dirname(file)),
      )
    )
      throw new Error("Unsafe session purge path");
    const target = join(folder, basename(file));
    try {
      const stat = await lstat(target);
      if (!stat.isFile()) throw new Error("Not an owned session file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return target;
  }
}
