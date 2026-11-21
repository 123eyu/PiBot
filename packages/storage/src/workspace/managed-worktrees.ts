import type { DatabaseSync } from "node:sqlite";
import { type ManagedWorktree, ManagedWorktreeSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { transaction } from "../database/database.ts";

export const ManagedIdentitySchema = z.strictObject({
  path: z.string(),
  device: z.string(),
  inode: z.string(),
});
export type ManagedIdentity = z.infer<typeof ManagedIdentitySchema>;
export interface ManagedRecord extends ManagedWorktree {
  commonDir: string;
  sourceIdentity: ManagedIdentity;
  identity: { root: ManagedIdentity; git: ManagedIdentity; common: ManagedIdentity } | null;
  requestId: string;
}
export interface AllocationRecord {
  id: string;
  botId: string;
  scopeKey: string;
  parentPath: string;
  identity: ManagedIdentity;
  expiresAt: string;
  consumedBy: string | null;
}
const columns = `id,bot_id AS botId,source_path AS sourcePath,path,common_dir AS commonDir,
 branch,base_head AS baseHead,head,source_identity_json AS sourceIdentity,identity_json AS identity,
 state,version,request_id AS requestId,created_at AS createdAt,updated_at AS updatedAt`;
function record(row: Record<string, unknown>): ManagedRecord {
  return {
    ...ManagedWorktreeSchema.strip().parse({ ...row, bindingRequired: true }),
    commonDir: String(row.commonDir),
    requestId: String(row.requestId),
    sourceIdentity: ManagedIdentitySchema.parse(JSON.parse(String(row.sourceIdentity))),
    identity:
      row.identity === null
        ? null
        : z
            .strictObject({
              root: ManagedIdentitySchema,
              git: ManagedIdentitySchema,
              common: ManagedIdentitySchema,
            })
            .parse(JSON.parse(String(row.identity))),
  };
}
export class ManagedWorktreesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string) {
    const row = this.db.prepare(`SELECT ${columns} FROM managed_worktrees WHERE id=?`).get(id);
    return row ? record(row) : undefined;
  }
  request(id: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM managed_worktrees WHERE request_id=?`)
      .get(id);
    return row ? record(row) : undefined;
  }
  byPath(path: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM managed_worktrees WHERE path=? AND state='ready'`)
      .get(path);
    return row ? record(row) : undefined;
  }
  /** Discovery is project-wide; callers must independently verify physical Git identities. */
  project(commonDir: string) {
    return this.db
      .prepare(`SELECT m.id,w.task_id AS taskId,w.integration_path AS integrationPath,
      w.group_id AS groupId,w.source_conversation_id AS sourceConversationId
      FROM managed_worktrees m LEFT JOIN group_member_workspaces w ON w.worktree_id=m.id
      WHERE m.common_dir=? AND m.state<>'removed' ORDER BY m.id LIMIT 251`)
      .all(commonDir)
      .map((row) => ({
        ...(this.get(String(row.id)) as ManagedRecord),
        ...(row.taskId
          ? {
              taskId: String(row.taskId),
              integrationPath: String(row.integrationPath),
              groupId: String(row.groupId),
              sourceConversationId: String(row.sourceConversationId),
            }
          : {}),
      }));
  }
  taskOwned(id: string) {
    return !!this.db.prepare("SELECT 1 FROM group_member_workspaces WHERE worktree_id=?").get(id);
  }
  list(botId: string, source: string, limit: number, before?: string) {
    return this.db
      .prepare(`SELECT ${columns} FROM managed_worktrees WHERE bot_id=? AND source_path=?
      AND NOT EXISTS (SELECT 1 FROM group_member_workspaces g WHERE g.worktree_id=managed_worktrees.id)
      AND (? IS NULL OR rowid<(SELECT rowid FROM managed_worktrees WHERE id=?)) ORDER BY rowid DESC LIMIT ?`)
      .all(botId, source, before ?? null, before ?? null, limit + 1)
      .map(record);
  }
  /** A view grant never becomes an execution binding or a write capability. */
  views(
    source: string,
    botId: string,
    groupId?: string,
    conversationId?: string,
    selected?: string,
  ) {
    return this.db
      .prepare(`SELECT id FROM managed_worktrees m WHERE source_path=? AND state='ready' AND (
        (bot_id=? AND NOT EXISTS (SELECT 1 FROM group_member_workspaces w WHERE w.worktree_id=m.id))
        OR EXISTS (SELECT 1 FROM group_member_workspaces w
          WHERE w.worktree_id=m.id AND w.group_id=? AND w.source_conversation_id=?))
        ORDER BY (id=?) DESC,rowid DESC LIMIT 50`)
      .all(source, botId, groupId ?? null, conversationId ?? null, selected ?? null)
      .map((row) => this.get(String(row.id)) as ManagedRecord);
  }
  listForScope(
    botId: string,
    source: string,
    groupId: string | undefined,
    conversationId: string | undefined,
    limit: number,
    before?: string,
  ) {
    return this.db
      .prepare(`SELECT m.id,w.task_id AS taskId,w.integration_path AS integrationPath
      FROM managed_worktrees m LEFT JOIN group_member_workspaces w ON w.worktree_id=m.id
      WHERE m.source_path=? AND m.state<>'removed' AND ((m.bot_id=? AND w.task_id IS NULL)
        OR (w.group_id=? AND w.source_conversation_id=?))
      AND (? IS NULL OR m.rowid<(SELECT rowid FROM managed_worktrees WHERE id=?))
      ORDER BY m.rowid DESC LIMIT ?`)
      .all(
        source,
        botId,
        groupId ?? null,
        conversationId ?? null,
        before ?? null,
        before ?? null,
        limit + 1,
      )
      .map((row) => ({
        ...(this.get(String(row.id)) as ManagedRecord),
        ...(row.taskId
          ? { taskId: String(row.taskId), integrationPath: String(row.integrationPath) }
          : {}),
      }));
  }
  count(commonDir: string) {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM managed_worktrees WHERE common_dir=? AND state!='removed'",
        )
        .get(commonDir)?.n ?? 0,
    );
  }
  bind(scopeKey: string, botId: string, worktreeId: string, identity: ManagedIdentity) {
    this.db
      .prepare(
        "INSERT INTO managed_worktree_bindings(scope_key,worktree_id,bot_id,identity_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET worktree_id=excluded.worktree_id,bot_id=excluded.bot_id,identity_json=excluded.identity_json,updated_at=excluded.updated_at",
      )
      .run(scopeKey, worktreeId, botId, JSON.stringify(identity), new Date().toISOString());
  }
  bindings(id: string) {
    return this.db
      .prepare(
        "SELECT scope_key AS scopeKey FROM managed_worktree_bindings WHERE worktree_id=? LIMIT 501",
      )
      .all(id)
      .map((row) => String(row.scopeKey));
  }
  unbind(scopeKey: string) {
    this.db.prepare("DELETE FROM managed_worktree_bindings WHERE scope_key=?").run(scopeKey);
  }
  allocate(input: Omit<AllocationRecord, "consumedBy">) {
    this.db
      .prepare(
        "INSERT INTO worktree_allocations(id,bot_id,scope_key,parent_path,identity_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.botId,
        input.scopeKey,
        input.parentPath,
        JSON.stringify(input.identity),
        input.expiresAt,
        new Date().toISOString(),
      );
  }
  allocation(id: string): AllocationRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id,bot_id AS botId,scope_key AS scopeKey,parent_path AS parentPath,identity_json AS identity,expires_at AS expiresAt,consumed_by AS consumedBy FROM worktree_allocations WHERE id=?",
      )
      .get(id);
    return row
      ? {
          id: String(row.id),
          botId: String(row.botId),
          scopeKey: String(row.scopeKey),
          parentPath: String(row.parentPath),
          identity: ManagedIdentitySchema.parse(JSON.parse(String(row.identity))),
          expiresAt: String(row.expiresAt),
          consumedBy: row.consumedBy === null ? null : String(row.consumedBy),
        }
      : undefined;
  }
  /** A runner reports the `.pibot/wt` identity only after it prepared the folder on create. */
  setAllocationIdentity(id: string, identity: ManagedIdentity) {
    this.db
      .prepare("UPDATE worktree_allocations SET identity_json=? WHERE id=?")
      .run(JSON.stringify(ManagedIdentitySchema.parse(identity)), id);
  }
  allocationForTree(id: string) {
    const row = this.db.prepare("SELECT id FROM worktree_allocations WHERE consumed_by=?").get(id);
    return row ? this.allocation(String(row.id)) : undefined;
  }
  create(input: ManagedRecord, allocationId: string) {
    transaction(this.db, () => {
      const consumed = this.db
        .prepare(
          "UPDATE worktree_allocations SET consumed_by=? WHERE id=? AND consumed_by IS NULL AND expires_at>?",
        )
        .run(input.id, allocationId, new Date().toISOString());
      if (!consumed.changes) throw new Error("worktree_allocation_stale");
      this.db
        .prepare(
          "INSERT INTO managed_worktrees(id,bot_id,source_path,path,common_dir,branch,base_head,head,source_identity_json,identity_json,state,version,request_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.botId,
          input.sourcePath,
          input.path,
          input.commonDir,
          input.branch,
          input.baseHead,
          input.head,
          JSON.stringify(input.sourceIdentity),
          input.identity ? JSON.stringify(input.identity) : null,
          input.state,
          input.version,
          input.requestId,
          input.createdAt,
          input.updatedAt,
        );
    });
  }
  update(id: string, version: number, update: Pick<ManagedRecord, "state" | "head" | "identity">) {
    const changed = this.db
      .prepare(
        "UPDATE managed_worktrees SET state=?,head=?,identity_json=?,version=version+1,updated_at=? WHERE id=? AND version=?",
      )
      .run(
        update.state,
        update.head,
        update.identity ? JSON.stringify(update.identity) : null,
        new Date().toISOString(),
        id,
        version,
      );
    if (!changed.changes) throw new Error("worktree_stale");
    return this.get(id) as ManagedRecord;
  }
  operation(id: string) {
    return this.db
      .prepare(
        "SELECT worktree_id AS worktreeId,kind,state,expected_json AS expected,observed_json AS observed FROM managed_git_operations WHERE id=?",
      )
      .get(id);
  }
  intent(
    id: string,
    worktreeId: string,
    kind: "create" | "integrate" | "remove",
    expected: unknown,
  ) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO managed_git_operations(id,worktree_id,kind,state,expected_json,created_at,updated_at) VALUES (?,?,?,'intent',?,?,?)",
      )
      .run(id, worktreeId, kind, JSON.stringify(expected), now, now);
  }
  settle(
    id: string,
    state: "running" | "done" | "conflict" | "interrupted",
    observed: unknown = null,
  ) {
    this.db
      .prepare("UPDATE managed_git_operations SET state=?,observed_json=?,updated_at=? WHERE id=?")
      .run(state, JSON.stringify(observed), new Date().toISOString(), id);
  }
}
