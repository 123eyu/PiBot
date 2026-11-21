import type { DatabaseSync } from "node:sqlite";
import { GroupExecutionReceiptSchema, GroupPlanConclusionSchema } from "@pibot/protocol-base";
import { z } from "zod";

const Roots = z
  .array(
    z.strictObject({
      id: z.string().uuid(),
      path: z.string().min(1).max(32768),
      device: z.string().min(1).max(100),
      inode: z.string().min(1).max(100),
    }),
  )
  .min(1)
  .max(21);
export type GroupAcpRoot = z.infer<typeof Roots>[number];

/** Metadata-only bounded projection; callers first prove ACP topic and source-run ownership. */
export class GroupAcpRepo {
  constructor(private readonly db: DatabaseSync) {}
  roots(topicId: string) {
    const value = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`acp-group-roots:${topicId}`);
    if (!value) return undefined;
    try {
      return Roots.parse(JSON.parse(String(value.value)));
    } catch {
      return undefined;
    }
  }
  setRoots(topicId: string, roots: GroupAcpRoot[]) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`acp-group-roots:${topicId}`, JSON.stringify(Roots.parse(roots)));
  }
  previousTopic(topicId: string) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`acp-group-previous:${topicId}`);
    return typeof row?.value === "string" ? row.value : undefined;
  }
  setPreviousTopic(topicId: string, previous: string) {
    this.db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING")
      .run(`acp-group-previous:${topicId}`, previous);
  }
  runIds(groupId: string, topicId: string, cycleId: string) {
    return this.db
      .prepare(`SELECT r.id FROM runs r JOIN conversations c ON c.id=r.conversation_id
      WHERE r.group_id=? AND r.cycle_id=? AND (c.id=? OR c.thread_of=?)
      ORDER BY r.rowid LIMIT 513`)
      .all(groupId, cycleId, topicId, topicId)
      .map((r) => String(r.id));
  }
  executionTasks(rootRunId: string) {
    return this.db
      .prepare(
        "SELECT id,bot_id AS botId,source_conversation_id AS conversationId,run_id AS runId,status FROM task_instances WHERE root_run_id=? AND deleted_at IS NULL ORDER BY id LIMIT 513",
      )
      .all(rootRunId)
      .map((row) => ({
        id: String(row.id),
        botId: String(row.botId),
        conversationId: String(row.conversationId),
        runId: row.runId == null ? null : String(row.runId),
        status: String(row.status),
      }));
  }
  tasks(groupId: string, topicId: string, cycleId: string) {
    return this.db
      .prepare(`SELECT DISTINCT t.id,t.assignee_bot_id AS botId,t.status FROM group_tasks t
      JOIN conversations c ON c.id=t.thread_conversation_id
      WHERE t.group_id=? AND c.thread_of=? AND (
        EXISTS(SELECT 1 FROM group_task_origins o WHERE o.task_id=t.id AND o.cycle_id=?) OR
        EXISTS(SELECT 1 FROM runs r WHERE r.task_id=t.id AND r.group_id=t.group_id AND r.cycle_id=?))
      ORDER BY t.id LIMIT 513`)
      .all(groupId, topicId, cycleId, cycleId)
      .map((r) => ({ id: String(r.id), botId: String(r.botId), status: String(r.status) }));
  }
  workflowIds(groupId: string, topicId: string, cycleId: string) {
    return this.db
      .prepare(`SELECT w.id FROM group_workflow_runs w JOIN messages m ON m.id=w.source_message_id
      WHERE w.group_id=? AND w.cycle_id=? AND m.conversation_id=? ORDER BY w.rowid LIMIT 129`)
      .all(groupId, cycleId, topicId)
      .map((r) => String(r.id));
  }
  completion(runId: string) {
    const row = this.db
      .prepare(`SELECT json_extract(m.usage,'$.groupExecution') AS fact FROM runs r
      JOIN messages m ON m.id=r.message_id WHERE r.id=? AND r.status='done' AND (r.task_id IS NULL OR EXISTS (
        SELECT 1 FROM group_tasks t JOIN group_task_sources s ON s.task_id=t.id
        WHERE t.id=r.task_id AND t.group_id=r.group_id AND t.assignee_bot_id=r.bot_id
        AND t.status='done' AND s.kind='user' AND s.message_id=r.user_message_id
        AND s.conversation_id=r.conversation_id))`)
      .get(runId);
    if (typeof row?.fact !== "string") return false;
    try {
      const value = GroupExecutionReceiptSchema.safeParse(JSON.parse(row.fact));
      return value.success && value.data.kind === "solo" && value.data.completed !== false;
    } catch {
      return false;
    }
  }
  planConclusion(topicId: string, workflowRunId: string, cycleId: string) {
    const row = this.db
      .prepare(`SELECT json_extract(usage,'$.groupPlanConclusion') AS fact
      FROM messages WHERE conversation_id=? AND status='done'
      AND json_extract(usage,'$.groupPlanConclusion.workflowRunId')=?
      AND bot_id=(SELECT coordinator_bot_id FROM group_workflow_runs WHERE id=json_extract(messages.usage,'$.groupPlanConclusion.workflowRunId'))
      ORDER BY rowid DESC LIMIT 1`)
      .get(topicId, workflowRunId);
    if (!row) return undefined;
    if (typeof row.fact !== "string") return "unknown";
    try {
      const parsed = GroupPlanConclusionSchema.safeParse(JSON.parse(row.fact));
      return parsed.success && parsed.data.cycleId === cycleId ? parsed.data.outcome : "unknown";
    } catch {
      return "unknown";
    }
  }
  planPublished(topicId: string, workflowRunId: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM messages WHERE conversation_id=? AND status='done'
      AND json_extract(usage,'$.groupPlanDone.workflowRunId')=? LIMIT 1`)
      .get(topicId, workflowRunId);
  }
  approvalPending(runId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM approvals WHERE run_id=? AND status='pending' LIMIT 1")
      .get(runId);
  }
  backgroundActive(runId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM background_commands WHERE run_id=? AND status='running' LIMIT 1")
      .get(runId);
  }
  stopped(runId: string) {
    return !!this.db.prepare("SELECT 1 FROM settings WHERE key=?").get(`acp-group-stop:${runId}`);
  }
  stop(runId: string) {
    this.db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING")
      .run(`acp-group-stop:${runId}`, "true");
  }
}
