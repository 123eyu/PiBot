import type { DatabaseSync } from "node:sqlite";
import { type Memory, MemorySchema } from "@pibot/protocol-base";

const content = MemorySchema.pick({ text: true, why: true, how: true }).strip();
const sourceRevision = MemorySchema.pick({
  text: true,
  category: true,
  why: true,
  how: true,
  sources: true,
  updatedAt: true,
}).strip();
type Content = { text: string; why?: string | null; how?: string | null };
const plain = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
const identical = (a: Content, b: Content) =>
  plain(a.text) === plain(b.text) && plain(a.why) === plain(b.why) && plain(a.how) === plain(b.how);

export function linkScopeMove(
  db: DatabaseSync,
  removalId: string,
  source: Content & {
    id: string;
    botId: string;
    updatedAt: string;
    category: string | null;
    sources: unknown;
  },
  copy: Content,
  target: { proposalId?: string; memoryId?: string; before?: Memory },
) {
  db.prepare(`INSERT INTO memory_scope_moves
    (removal_id,source_id,target_bot_id,target_proposal_id,target_memory_id,source_json,copy_json,target_before_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    removalId,
    source.id,
    source.botId,
    target.proposalId ?? null,
    target.memoryId ?? null,
    JSON.stringify(sourceRevision.parse(source)),
    JSON.stringify(content.parse(copy)),
    target.before ? JSON.stringify(sourceRevision.parse(target.before)) : null,
  );
  if (target.proposalId && target.before)
    db.prepare("UPDATE scoped_memory_proposals SET scope_move_target_before_json=? WHERE id=?").run(
      JSON.stringify(sourceRevision.parse(target.before)),
      target.proposalId,
    );
}

export function isScopeMove(db: DatabaseSync, proposalId: string): boolean {
  return !!db.prepare("SELECT 1 FROM memory_scope_moves WHERE removal_id=?").get(proposalId);
}

/** Called inside the same write transaction as resolve, never trusting a pending copy. */
export function scopeMoveHasLiveCopy(db: DatabaseSync, proposalId: string): boolean {
  const move = db.prepare("SELECT * FROM memory_scope_moves WHERE removal_id=?").get(proposalId);
  if (!move) return true;
  const source = db
    .prepare(`SELECT text,why,how,category,updated_at AS updatedAt,sources_json FROM scoped_memories
    WHERE id=? AND scope='user' AND owner_id='user' AND archived_at IS NULL`)
    .get(String(move.source_id));
  const target =
    move.target_proposal_id == null
      ? undefined
      : db
          .prepare(`SELECT resolved_memory_id
    FROM scoped_memory_proposals WHERE id=? AND status='accepted'`)
          .get(String(move.target_proposal_id));
  const targetId =
    move.target_proposal_id == null ? move.target_memory_id : target?.resolved_memory_id;
  const copy =
    targetId == null
      ? undefined
      : db
          .prepare(`SELECT m.text,m.why,m.how FROM scoped_memories m JOIN bots b ON b.id=m.owner_id
    WHERE m.id=? AND m.scope='bot' AND m.owner_id=? AND m.archived_at IS NULL AND b.archived_at IS NULL`)
          .get(String(targetId), String(move.target_bot_id));
  if (
    !source ||
    !copy ||
    JSON.stringify(
      sourceRevision.parse({
        ...source,
        sources: JSON.parse(String(source.sources_json)) as unknown,
      }),
    ) !== JSON.stringify(sourceRevision.parse(JSON.parse(String(move.source_json)) as unknown)) ||
    !identical(content.parse(copy), content.parse(JSON.parse(String(move.copy_json)) as unknown))
  )
    return false;
  return true;
}

/** Restoring the shared note must precede undoing the destination, or the only copy is lost. */
export function scopeMoveCanUndo(db: DatabaseSync, proposalId: string): boolean {
  const moves = db
    .prepare("SELECT source_id,source_json FROM memory_scope_moves WHERE target_proposal_id=?")
    .all(proposalId);
  for (const move of moves) {
    const source = db
      .prepare(`SELECT text,why,how FROM scoped_memories
      WHERE id=? AND scope='user' AND owner_id='user' AND archived_at IS NULL`)
      .get(String(move.source_id));
    if (
      !source ||
      !identical(
        content.parse(source),
        content.parse(JSON.parse(String(move.source_json)) as unknown),
      )
    )
      return false;
  }
  return true;
}

/** A Bot rewrite must not overwrite edits made since the move was proposed. */
export function scopeMoveDestinationUnchanged(db: DatabaseSync, proposalId: string): boolean {
  const proposal = db
    .prepare("SELECT scope_move_target_before_json FROM scoped_memory_proposals WHERE id=?")
    .get(proposalId);
  if (!proposal?.scope_move_target_before_json) return true;
  const target = db
    .prepare(`SELECT m.text,m.category,m.why,m.how,m.sources_json,m.updated_at AS updatedAt
    FROM scoped_memory_proposals p JOIN scoped_memories m ON m.id=p.memory_id
    WHERE p.id=? AND m.scope='bot' AND m.owner_id=p.owner_id AND m.archived_at IS NULL`)
    .get(proposalId);
  return (
    !!target &&
    JSON.stringify(
      sourceRevision.parse({
        ...target,
        sources: JSON.parse(String(target.sources_json)) as unknown,
      }),
    ) ===
      JSON.stringify(
        sourceRevision.parse(JSON.parse(String(proposal.scope_move_target_before_json)) as unknown),
      )
  );
}
