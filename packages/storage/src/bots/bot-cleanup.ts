import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@pibot/protocol-base";
import { z } from "zod";
import type { CleanupManifest } from "../database/cleanup.ts";

const jobSchema = z.strictObject({
  botId: IdSchema,
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
export type BotCleanupJob = z.infer<typeof jobSchema>;
export class BotCleanupRepo {
  constructor(private readonly db: DatabaseSync) {}
  enqueue(botId: string, manifest: CleanupManifest) {
    const value = jobSchema.parse({ botId, ...manifest });
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`bot-cleanup:${botId}`, JSON.stringify(value));
    this.db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`memory-undo:${botId}:%`);
    this.db.prepare("DELETE FROM settings WHERE key=?").run(`bot-hooks:${botId}`);
  }
  page(before?: string, limit = 50): BotCleanupJob[] {
    if (before) IdSchema.parse(before);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new TypeError("Invalid cleanup page");
    return this.db
      .prepare(
        "SELECT value FROM settings WHERE key LIKE 'bot-cleanup:%' AND key>? ORDER BY key LIMIT ?",
      )
      .all(before ? `bot-cleanup:${before}` : "bot-cleanup:", limit)
      .map((r) => jobSchema.parse(JSON.parse(String(r.value))));
  }
  complete(botId: string) {
    this.db.prepare("DELETE FROM settings WHERE key=?").run(`bot-cleanup:${IdSchema.parse(botId)}`);
  }
}
