import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Root/file identities are hashed by the caller; no project text is persisted here. */
export class ProjectNotesRepo {
  constructor(private readonly db: DatabaseSync) {}

  observe(identity: string, hash: string): boolean {
    const key = `project-notes:${digest.parse(identity)}`;
    digest.parse(hash);
    const before = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, hash);
    return before !== undefined && before.value !== hash;
  }
}
