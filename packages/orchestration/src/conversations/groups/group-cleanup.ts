import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveSessionFile } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import { IdSchema } from "@pibot/protocol-base";
import { type CleanupManifest, resolveAttachmentPath } from "@pibot/storage";
import { z } from "zod";

const manifestSchema = z.strictObject({
  sessionFiles: z.array(z.string()),
  attachmentPaths: z.array(z.string()),
  attachments: z.array(
    z.strictObject({
      id: IdSchema,
      botId: IdSchema,
      path: z.string(),
      textPath: z.string().nullable(),
    }),
  ),
});
export class GroupCleanup {
  private pending?: Promise<void>;
  private readonly shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  async pause() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
  resume() {
    if (!this.shutdown.signal.aborted) this.start();
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly logger: Logger,
  ) {}
  enqueue(groupId: string, manifest: CleanupManifest) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(
        `group-cleanup:${IdSchema.parse(groupId)}`,
        JSON.stringify(manifestSchema.parse(manifest)),
      );
  }
  start() {
    if (this.timer || this.shutdown.signal.aborted) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, 3_600_000);
    this.timer.unref();
    void this.sweep();
  }
  sweep() {
    this.pending ??= this.perform()
      .catch(() => {
        if (!this.shutdown.signal.aborted) this.logger.warn("Group file cleanup deferred");
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async remove(file: string, botId: string, kind: "sessions" | "attachments") {
    const root = await realpath(this.dataDir);
    const owned = join(root, "bots", IdSchema.parse(botId), kind);
    // Accept the original spelling of a /tmp data root, but no arbitrary path or directory deletion.
    if (![owned, join(resolve(this.dataDir), "bots", botId, kind)].includes(resolve(dirname(file))))
      throw new Error("Unsafe group cleanup path");
    for (const path of [join(root, "bots"), join(root, "bots", botId), owned]) {
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(path)) !== path)
          throw new Error("Unsafe cleanup root");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    this.shutdown.signal.throwIfAborted();
    const target = join(owned, basename(file));
    try {
      const stat = await lstat(target);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Not an owned file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(target, { force: true });
  }
  private async removeGroupSkills(groupId: string) {
    if (this.db.prepare("SELECT 1 FROM groups WHERE id=?").get(groupId))
      throw new Error("Group still exists");
    const root = await realpath(this.dataDir);
    const groups = join(root, "groups"),
      group = join(groups, IdSchema.parse(groupId)),
      owned = join(group, "bots");
    for (const path of [groups, group, owned]) {
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
          throw new Error("Unsafe group skills cleanup");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    this.shutdown.signal.throwIfAborted();
    await rm(owned, { recursive: true, force: true });
  }
  private async perform() {
    let before = "group-cleanup:";
    for (;;) {
      this.shutdown.signal.throwIfAborted();
      const page = this.db
        .prepare(
          "SELECT key,value FROM settings WHERE key LIKE 'group-cleanup:%' AND key>? ORDER BY key LIMIT 50",
        )
        .all(before);
      for (const row of page) {
        const job = manifestSchema.parse(JSON.parse(String(row.value)));
        try {
          for (const stored of job.sessionFiles) {
            const file = resolveSessionFile(this.dataDir, stored);
            const botId = basename(dirname(dirname(file)));
            if (!file.endsWith(".jsonl")) throw new Error("Unsafe session cleanup");
            await this.remove(file, botId, "sessions");
          }
          for (const item of job.attachments) {
            // Manifests hold the stored form; jobs queued before relative paths hold absolute ones.
            const path = resolveAttachmentPath(this.dataDir, item.path);
            for (const stored of [item.path, item.textPath])
              if (stored) {
                const file = resolveAttachmentPath(this.dataDir, stored);
                if (!basename(file).startsWith(`${item.id}.`))
                  throw new Error("Unsafe attachment cleanup");
                await this.remove(file, item.botId, "attachments");
              }
            for (let i = 1; i <= 10; i++)
              await this.remove(
                join(dirname(path), `${item.id}.page-${i}.png`),
                item.botId,
                "attachments",
              );
          }
          await this.removeGroupSkills(String(row.key).slice("group-cleanup:".length));
          this.db.prepare("DELETE FROM settings WHERE key=?").run(String(row.key));
        } catch {
          this.shutdown.signal.throwIfAborted();
          this.logger.warn("Group cleanup job retained for retry");
        }
      }
      if (page.length < 50) break;
      before = String(page.at(-1)?.key);
    }
  }
  async stop() {
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.pending;
  }
}
