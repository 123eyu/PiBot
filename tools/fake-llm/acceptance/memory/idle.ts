import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { MemoryExtractionsRepo } from "../../../../packages/storage/src/bots/memory-extraction.ts";
import { configureChatSearchRedactor } from "../../../../packages/storage/src/conversations/chat-search-index.ts";
import { requireThat } from "./assert.ts";
/** Probe only a private SQLite snapshot; the running product's timestamps remain untouched. */
export async function sixHours(source: DatabaseSync, root: string, topicId: string) {
  const path = join(root, "idle-probe.db");
  await backup(source, path);
  const db = new DatabaseSync(path);
  try {
    // SQLite backups do not retain connection-local functions used by message triggers.
    configureChatSearchRedactor(db);
    const repo = new MemoryExtractionsRepo(db);
    const now = Date.now();
    const due = () =>
      repo
        .dueTopics(
          new Date(now - 6 * 3600_000).toISOString(),
          new Date(now - 3600_000).toISOString(),
          new Date(now - 86400_000).toISOString(),
        )
        .some((t) => t.conversationId === topicId);
    // dueTopics uses the newest message's created_at, not conversations.updated_at.
    requireThat(!due(), "fresh_topic_is_due");
    db.prepare("UPDATE messages SET created_at=? WHERE conversation_id=?").run(
      new Date(now - 6 * 3600_000 - 60_000).toISOString(),
      topicId,
    );
    requireThat(due(), "old_topic_not_due");
    db.prepare("UPDATE messages SET created_at=? WHERE conversation_id=?").run(
      new Date(now - 6 * 3600_000 + 60_000).toISOString(),
      topicId,
    );
    requireThat(!due(), "under_six_hours_is_due");
  } finally {
    db.close();
  }
}
