import type { DatabaseSync } from "node:sqlite";
import { type Memory, MemorySchema } from "@pibot/protocol-base";
import { BotsRepo, linkScopeMove, transaction } from "@pibot/storage";
import type { MemoryService } from "./memory-service.ts";
import { looksLikeWorkFact } from "./memory-work-facts.ts";

/**
 * Maintainers 2026-11-11 ("fix both + move existing"): development Bots had written their working facts
 * into the shared user scope. A move is offered, never performed: it is the same pair of ordinary
 * pending proposals an organization merge uses (add to the source Bot's own scope, remove from the
 * user scope), so accepting, rejecting and undoing work exactly like other organization proposals.
 * A move never deletes text that does not survive in the Bot's scope.
 */
export interface MovableNote {
  id: string;
  botId: string;
  messageId: string | null;
  updatedAt: string;
  text: string;
  category: string | null;
  why: string | null;
  how: string | null;
  sources: NonNullable<ReturnType<typeof MemorySchema.parse>["sources"]>;
}

/**
 * Active user notes whose every recorded source is one active, non-main Bot. Notes added by the
 * person (manual import runs as the main Bot), by the main Bot, or merged from several Bots have no
 * single owner to move to and are never offered by the startup scan. Explicit owner runs can
 * include the main Bot, but still require a nonempty, valid single-Bot provenance list.
 */
export function movableUserNotes(
  db: DatabaseSync,
  ownerInitiated = false,
  ids?: readonly string[],
): Map<string, MovableNote> {
  if (ids?.length === 0) return new Map();
  const bots = new BotsRepo(db);
  const rows = db
    .prepare(
      `SELECT id, bot_id AS botId, source_message_id AS messageId, sources_json, text, category, why, how, updated_at AS updatedAt
      FROM scoped_memories WHERE scope='user' AND owner_id='user' AND archived_at IS NULL
      ${ids ? `AND id IN (${ids.map(() => "?").join(",")})` : ""}
      ORDER BY created_at, id LIMIT 500`,
    )
    .all(...(ids ?? []));
  const result = new Map<string, MovableNote>();
  for (const row of rows) {
    let sources: NonNullable<ReturnType<typeof MemorySchema.parse>["sources"]>;
    try {
      sources = MemorySchema.shape.sources
        .unwrap()
        .parse(JSON.parse(String(row.sources_json ?? "[]")));
    } catch {
      // Unknown or mixed provenance cannot establish a destination, even for an owner run.
      continue;
    }
    if (!sources.length) continue;
    const botIds = new Set(sources.map((source) => String(source.botId ?? "")));
    if (botIds.size !== 1) continue;
    const botId = [...botIds][0] ?? "";
    const bot = bots.get(botId);
    if (!bot || bot.archivedAt || (!ownerInitiated && bot.isMain)) continue;
    const messageId = sources.find((source) => typeof source.messageId === "string")?.messageId;
    result.set(String(row.id), {
      sources,
      updatedAt: String(row.updatedAt),
      id: String(row.id),
      botId,
      messageId: typeof messageId === "string" ? messageId : null,
      text: String(row.text),
      category: row.category == null ? null : String(row.category),
      why: row.why == null ? null : String(row.why),
      how: row.how == null ? null : String(row.how),
    });
  }
  return result;
}

/**
 * Proposes one move. Idempotent per note: any earlier removal proposal for it — pending, accepted,
 * rejected or undone — means the person has already been asked, so it is never asked again.
 * Returns the number of proposals created: 2 normally (Bot add, or Bot rewrite holding both sides'
 * text and why/how, plus the user removal), 1 when the Bot already has the identical note active,
 * 0 when skipped (already asked, archived look-alike, or why/how too long to merge faithfully).
 */
export function proposeScopeMove(
  memory: MemoryService,
  db: DatabaseSync,
  note: MovableNote,
): number {
  const asked = db
    .prepare(
      "SELECT 1 FROM scoped_memory_proposals WHERE scope='user' AND owner_id='user' AND action='remove' AND memory_id=? LIMIT 1",
    )
    .get(note.id);
  if (asked) return 0;
  // The source topic is shown with the proposal when it still belongs to that Bot's own chats.
  const messageId =
    note.messageId &&
    db
      .prepare(
        "SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.bot_id=?",
      )
      .get(note.messageId, note.botId)
      ? note.messageId
      : null;
  return transaction(db, () => {
    const existing = memory.similar(note.botId, note.text, "bot");
    // An archived look-alike is not a live copy, and an add would be refused as similar to it;
    // with no faithful way to move, nothing is offered and the note stays where it is.
    if (existing?.archivedAt) return 0;
    let target: { proposalId?: string; memoryId?: string; before?: Memory } = {};
    let copy = { text: note.text, why: note.why, how: note.how };
    if (!existing) {
      const added = memory.execute(
        note.botId,
        messageId,
        {
          tool: "memory_add",
          args: {
            scope: "bot",
            text: note.text,
            category: note.category === "how_to" ? "how_to" : "work",
            ...(note.why ? { why: note.why } : {}),
            ...(note.how ? { how: note.how } : {}),
          },
        },
        ...ALWAYS_PROPOSE,
      );
      target = { proposalId: added.proposal.id };
    } else {
      // Similar is not identical (deploy.js vs deploy.ts, or the same text with other why/how):
      // the Bot's note is offered rewritten to hold both sides in full. When the merged why/how
      // would not fit, the move is not offered at all, so the removal can never drop anything.
      const why = mergedNote(existing.why, note.why);
      const how = mergedNote(existing.how, note.how);
      if (why === false || how === false) return 0;
      const text =
        plain(existing.text) === plain(note.text) ? undefined : `${existing.text}\n${note.text}`;
      copy = {
        text: text ?? existing.text,
        why: why ?? existing.why ?? null,
        how: how ?? existing.how ?? null,
      };
      target = { memoryId: existing.id };
      // Nothing to add (identical, or the Bot's note already holds the moved why/how): delete only.
      if (text !== undefined || why !== undefined || how !== undefined) {
        const updated = memory.execute(
          note.botId,
          messageId,
          {
            tool: "memory_update",
            args: {
              scope: "bot",
              id: existing.id,
              ...(text === undefined ? {} : { text }),
              ...(why === undefined ? {} : { why }),
              ...(how === undefined ? {} : { how }),
            },
          },
          ...ALWAYS_PROPOSE,
        );
        target = { proposalId: updated.proposal.id, before: existing };
      }
    }
    // Confirmation must wait until the destination is a live, faithful copy.
    const removal = memory.execute(
      note.botId,
      null,
      { tool: "memory_remove", args: { scope: "user", id: note.id } },
      ...ALWAYS_PROPOSE,
    );
    linkScopeMove(db, removal.proposal.id, note, copy, target);
    // The scope move keeps the destination proposal as an internal dependency, while the source row is the
    // single user-facing move card. Its preview is metadata, never a second authorization path.
    // The stored action stays 'remove' (the table's CHECK allows add/update/remove only); a
    // removal with a move target is read back as action 'move'.
    db.prepare(`UPDATE scoped_memory_proposals SET move_target_bot_id=?,
      move_target_memory_id=?, move_target_text=?, move_target_why=?, move_target_how=? WHERE id=?`).run(
      note.botId,
      target.memoryId ?? null,
      copy.text,
      copy.why,
      copy.how,
      removal.proposal.id,
    );
    return 1;
  });
}

/**
 * undefined: keep the Bot's own value (it already covers the moved one); a string: the value to
 * write; false: both sides differ and do not fit one note together, so a merge would lose one.
 */
function mergedNote(
  own: string | null | undefined,
  moved: string | null,
): string | undefined | false {
  if (!plain(moved) || plain(own) === plain(moved)) return undefined;
  if (!plain(own)) return moved ?? undefined;
  const both = `${own}；${moved}`;
  return Array.from(both).length <= MEMORY_NOTE_CHARS ? both : false;
}
// MemoryNoteSchema's per-field limit for why/how.
const MEMORY_NOTE_CHARS = 300;

// No run, not automatic, always a pending proposal — the same flags organization uses.
const ALWAYS_PROPOSE = [false, undefined, undefined, undefined, undefined, true] as const;

const plain = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/**
 * Startup pass, no model call: offers a move for every user note from a single non-main Bot that
 * carries an unmistakable work marker (see memory-work-facts.ts). Subtler cases need a model, and
 * no model call may run for this without the owner starting it, so they are not offered here.
 */
export function proposeScopeMoves(memory: MemoryService, db: DatabaseSync) {
  let notes = 0;
  let proposals = 0;
  let failed = 0;
  for (const note of movableUserNotes(db).values()) {
    if (!looksLikeWorkFact(note.text)) continue;
    try {
      const created = proposeScopeMove(memory, db, note);
      if (created) notes++;
      proposals += created;
    } catch {
      // One note that hit a quota or changed under us must not block the others; counted below.
      failed++;
    }
  }
  return { notes, proposals, failed };
}
