import type { DatabaseSync } from "node:sqlite";
import { type FolderSelection, FolderSelectionSchema } from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

export const homeSelection: FolderSelection = { primary: "home", readonly: [] };

/**
 * A DM topic's folders. The primary stays in `conversations.workplace_folder_id`
 * (`NULL`, the older "follow the Bot", now reads as `home`). Additional associations live in
 * `topic_folders`; only explicit writable markers grant writes, so old references stay read-only.
 * Changes bump `workplace_revision`, invalidating run and approval snapshots.
 */
export class TopicFoldersRepo {
  constructor(private readonly db: DatabaseSync) {}

  selection(topicId: string): FolderSelection {
    const topic = this.db
      .prepare("SELECT workplace_folder_id AS primaryId FROM conversations WHERE id=?")
      .get(topicId);
    if (!topic) throw new TypeError("Unknown topic");
    const readonly = this.db
      .prepare(
        "SELECT folder_id FROM topic_folders WHERE conversation_id=? AND NOT EXISTS (SELECT 1 FROM topic_writable_folders w WHERE w.conversation_id=topic_folders.conversation_id AND w.folder_id=topic_folders.folder_id) ORDER BY position, folder_id LIMIT 32",
      )
      .all(topicId)
      .map((row) => String(row.folder_id));
    const primary = topic.primaryId == null ? "home" : String(topic.primaryId);
    const writable = this.db
      .prepare(
        "SELECT w.folder_id FROM topic_writable_folders w JOIN topic_folders t ON t.conversation_id=w.conversation_id AND t.folder_id=w.folder_id WHERE w.conversation_id=? ORDER BY t.position,w.folder_id LIMIT 4",
      )
      .all(topicId)
      .map((row) => String(row.folder_id));
    return {
      primary,
      readonly: readonly.filter((id) => id !== primary),
      ...(writable.length ? { writable } : {}),
    };
  }

  /**
   * What a new topic of this Bot starts with: the previous topic's folders (the Bot's current
   * topic, else its most recently updated one), else the legacy Bot folder, else `home`.
   */
  initial(botId: string, exclude?: string): FolderSelection {
    const current = this.db.prepare("SELECT value FROM settings WHERE key=?").get(`topic:${botId}`);
    const currentId = current ? (JSON.parse(String(current.value)) as unknown) : undefined;
    const candidate = this.db
      .prepare(
        `SELECT c.id FROM conversations c WHERE c.kind='dm' AND c.bot_id=? AND c.archived_at IS NULL AND c.routine_id IS NULL AND c.internal_task_id IS NULL AND c.acp_session=0
         AND id IS NOT ?
         AND NOT EXISTS (
           SELECT 1 FROM working_folders sf
           WHERE sf.bot_id=c.bot_id AND sf.association='session'
             AND (sf.id=c.workplace_folder_id OR EXISTS (
               SELECT 1 FROM topic_folders st WHERE st.conversation_id=c.id AND st.folder_id=sf.id
             ))
         )
         ORDER BY (id=?) DESC, updated_at DESC, id DESC LIMIT 1`,
      )
      .get(botId, exclude ?? null, typeof currentId === "string" ? currentId : null);
    if (candidate) return this.selection(String(candidate.id));
    const legacy = this.db
      .prepare("SELECT current_folder_id FROM bot_workplace WHERE bot_id=?")
      .get(botId);
    if (legacy?.current_folder_id != null) {
      const session = this.db
        .prepare("SELECT 1 FROM working_folders WHERE id=? AND association='session'")
        .get(legacy.current_folder_id);
      if (session) return homeSelection;
    }
    return legacy?.current_folder_id == null
      ? homeSelection
      : { primary: String(legacy.current_folder_id), readonly: [] };
  }

  /** The selection's folder IDs; throws unless every one is registered for this Bot. */
  validate(botId: string, selection: FolderSelection): string[] {
    const ids = [
      ...(selection.primary === "home" ? [] : [selection.primary]),
      ...selection.readonly,
      ...(selection.writable ?? []),
    ];
    if (ids.length) {
      const known = Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM working_folders WHERE bot_id=? AND id IN (${ids.map(() => "?").join(",")})`,
          )
          .get(botId, ...ids)?.n,
      );
      if (known !== ids.length) throw new TypeError("Unknown working folder");
    }
    return ids;
  }

  insertReadonly(botId: string, topicId: string, readonly: readonly string[]) {
    const insert = this.db.prepare(
      "INSERT INTO topic_folders(conversation_id, bot_id, folder_id, position) VALUES (?,?,?,?)",
    );
    readonly.forEach((id, position) => {
      insert.run(topicId, botId, id, position);
    });
  }

  insertWritable(botId: string, topicId: string, writable: readonly string[]) {
    const insert = this.db.prepare(
      "INSERT INTO topic_folders(conversation_id,bot_id,folder_id,position) VALUES (?,?,?,?)",
    );
    const marker = this.db.prepare(
      "INSERT INTO topic_writable_folders(conversation_id,folder_id) VALUES (?,?)",
    );
    writable.forEach((id, position) => {
      insert.run(topicId, botId, id, position + 32);
      marker.run(topicId, id);
    });
  }

  /** Writes the whole selection; `false` when nothing changed. The caller checks busy. */
  set(
    botId: string,
    topicId: string,
    input: FolderSelection,
    options?: { acpSession?: true },
  ): boolean {
    const parsed = FolderSelectionSchema.parse(input);
    const selection: FolderSelection = {
      primary: parsed.primary,
      readonly: parsed.readonly,
      ...(parsed.writable?.length ? { writable: parsed.writable } : {}),
    };
    return transaction(this.db, () => {
      const topic = this.db
        .prepare(
          "SELECT bot_id AS botId, kind, archived_at AS archivedAt, internal_task_id AS internalTaskId FROM conversations WHERE id=?",
        )
        .get(topicId);
      if (topic?.kind !== "dm" || topic.botId !== botId || topic.archivedAt || topic.internalTaskId)
        throw new TypeError("Unknown topic");
      const ids = this.validate(botId, selection);
      const before = this.selection(topicId);
      // The provenance belongs to the topic, not its shared folder rows. Keep it sticky when an
      // ACP root is later picked by the user, and commit it in the same transaction as the roots.
      const marked = options?.acpSession
        ? this.db
            .prepare("UPDATE conversations SET acp_session=1 WHERE id=? AND acp_session=0")
            .run(topicId).changes > 0
        : false;
      if (JSON.stringify(before) === JSON.stringify(selection)) return marked;
      this.db
        .prepare(
          "UPDATE conversations SET workplace_folder_id=?, workplace_revision=workplace_revision+1 WHERE id=? AND bot_id=? AND kind='dm'",
        )
        .run(selection.primary, topicId, botId);
      this.db.prepare("DELETE FROM topic_folders WHERE conversation_id=?").run(topicId);
      this.insertReadonly(botId, topicId, selection.readonly);
      this.insertWritable(botId, topicId, selection.writable ?? []);
      // Choosing a folder is what "recently used" means; references count as use too.
      const fresh = ids.filter(
        (id) =>
          id !== before.primary &&
          !before.readonly.includes(id) &&
          !(before.writable ?? []).includes(id),
      );
      if (fresh.length)
        this.db
          .prepare(
            `UPDATE working_folders SET last_used_at=? WHERE bot_id=? AND id IN (${fresh.map(() => "?").join(",")})`,
          )
          .run(new Date().toISOString(), botId, ...fresh);
      return true;
    });
  }
}
