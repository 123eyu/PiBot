import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const schema = z.strictObject({
  taskId: z.uuid(),
  sourceConversationId: z.uuid(),
  groupId: z.uuid(),
  botId: z.uuid(),
  worktreeId: z.uuid(),
  integrationPath: z.string(),
  /** runner:<id> when the worktree is on a runner; null on this desktop. */
  executionLocation: z.string().nullable().default(null),
  workspaceRevision: z.number().int().nonnegative(),
  state: z.enum([
    "preparing",
    "working",
    "awaiting_integration",
    "integrating",
    "integrated",
    "conflict",
    "interrupted",
    "removed",
  ]),
  errorCode: z.string().nullable(),
  runId: z.uuid().nullable(),
  updatedAt: z.string(),
});
export type GroupMemberWorkspace = z.infer<typeof schema>;
const columns = `task_id AS taskId,source_conversation_id AS sourceConversationId,group_id AS groupId,bot_id AS botId,worktree_id AS worktreeId,
 integration_path AS integrationPath,execution_location AS executionLocation,workspace_revision AS workspaceRevision,state,
 error_code AS errorCode,run_id AS runId,updated_at AS updatedAt`;

/** Each explicitly parallel task owns its branch and source topic. */
export class GroupMemberWorkspacesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(taskId: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM group_member_workspaces WHERE task_id=?`)
      .get(taskId);
    return row ? schema.parse(row) : undefined;
  }
  list(groupId: string, sourceConversationId?: string) {
    return this.db
      .prepare(
        `SELECT ${columns} FROM group_member_workspaces w WHERE group_id=?
        AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id=w.group_id AND m.bot_id=w.bot_id AND m.left_at IS NULL)
        AND (? IS NULL OR source_conversation_id=?) ORDER BY state IN ('integrated','removed'),updated_at DESC LIMIT 50`,
      )
      .all(groupId, sourceConversationId ?? null, sourceConversationId ?? null)
      .map((row) => schema.parse(row));
  }
  /** Workspaces not yet merged or removed, oldest first, for the cleanup sweep (bounded page). */
  open(limit = 200) {
    return this.db
      .prepare(
        `SELECT ${columns} FROM group_member_workspaces WHERE state NOT IN ('integrated','removed') ORDER BY updated_at LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 200))
      .map((row) => schema.parse(row));
  }
  /** Plan step workspaces of one managed folder repository (bounded: one plan's steps). */
  byIntegrationPath(path: string) {
    return this.db
      .prepare(
        `SELECT ${columns} FROM group_member_workspaces WHERE integration_path=? ORDER BY updated_at LIMIT 200`,
      )
      .all(path)
      .map((row) => schema.parse(row));
  }
  save(value: Omit<GroupMemberWorkspace, "updatedAt">) {
    const row = schema.parse({ ...value, updatedAt: new Date().toISOString() });
    this.db
      .prepare(`INSERT INTO group_member_workspaces(task_id,source_conversation_id,group_id,bot_id,worktree_id,integration_path,execution_location,workspace_revision,state,error_code,run_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET worktree_id=excluded.worktree_id,
      integration_path=excluded.integration_path,workspace_revision=excluded.workspace_revision,
      state=excluded.state,error_code=excluded.error_code,run_id=excluded.run_id,updated_at=excluded.updated_at`)
      .run(
        row.taskId,
        row.sourceConversationId,
        row.groupId,
        row.botId,
        row.worktreeId,
        row.integrationPath,
        row.executionLocation,
        row.workspaceRevision,
        row.state,
        row.errorCode,
        row.runId,
        row.updatedAt,
      );
    return row;
  }
  /**
   * Maintainers 2026-11-21: a plan step the group's pause stopped continues in the workspace it had,
   * but its rerun is a new task, so the row moves to that task. False when the row no longer holds
   * this tree in use (the caller then starts the rerun fresh).
   */
  rekey(fromTaskId: string, toTaskId: string, worktreeId: string) {
    return (
      this.db
        .prepare(
          "UPDATE group_member_workspaces SET task_id=?,updated_at=? WHERE task_id=? AND worktree_id=? AND state='working'",
        )
        .run(toTaskId, new Date().toISOString(), fromTaskId, worktreeId).changes === 1
    );
  }
  interrupted() {
    // A fully returned task can be reviewed after restart, never silently merged.
    this.db
      .prepare(`UPDATE group_member_workspaces SET state='awaiting_integration',updated_at=?
      WHERE state='working' AND EXISTS(SELECT 1 FROM runs r JOIN group_tasks t ON t.id=group_member_workspaces.task_id
      WHERE r.id=group_member_workspaces.run_id AND r.status='done' AND t.status='done')`)
      .run(new Date().toISOString());
    this.db
      .prepare(
        "UPDATE group_member_workspaces SET state='interrupted',error_code='group_workspace_interrupted',updated_at=? WHERE state IN ('preparing','integrating')",
      )
      .run(new Date().toISOString());
  }
}
