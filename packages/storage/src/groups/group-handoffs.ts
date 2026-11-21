import type { DatabaseSync } from "node:sqlite";
import {
  type GroupTaskHandoff,
  HANDOFF_ARTIFACTS,
  type HandoffPipeline,
  HandoffPipelineSchema,
  type HandoffResult,
  HandoffResultSchema,
  type HandoffSpec,
  HandoffSpecSchema,
  type HandoffState,
  HandoffStateSchema,
} from "@pibot/protocol-base";

export interface HandoffRecord {
  taskId: string;
  spec: HandoffSpec;
  pipeline: HandoffPipeline | null;
  /** Absolute folder the expected files and deliverables resolve in (null: not judged). */
  baseFolder: string | null;
  returnOf: string | null;
  state: HandoffState;
  result: HandoffResult | null;
  wakeRunId: string | null;
}

const columns =
  "task_id AS taskId,spec,pipeline,base_folder AS baseFolder,return_of AS returnOf,state,result,wake_run_id AS wakeRunId";

function parse(row: Record<string, unknown>): HandoffRecord {
  return {
    taskId: String(row.taskId),
    spec: HandoffSpecSchema.parse(JSON.parse(String(row.spec))),
    pipeline:
      row.pipeline === null ? null : HandoffPipelineSchema.parse(JSON.parse(String(row.pipeline))),
    baseFolder: row.baseFolder === null ? null : String(row.baseFolder),
    returnOf: row.returnOf === null ? null : String(row.returnOf),
    state: HandoffStateSchema.parse(row.state),
    result: row.result === null ? null : HandoffResultSchema.parse(JSON.parse(String(row.result))),
    wakeRunId: row.wakeRunId === null ? null : String(row.wakeRunId),
  };
}

/** Hand-off rows (migration 0074); every write is a single statement or the caller's transaction. */
export class GroupHandoffsRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(taskId: string): HandoffRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM group_task_handoffs WHERE task_id=?`)
      .get(taskId);
    return row ? parse(row) : undefined;
  }
  /** The hand-off whose completion woke this coordinator run (its sign-off run). */
  byWakeRun(runId: string): HandoffRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM group_task_handoffs WHERE wake_run_id=? LIMIT 1`)
      .get(runId);
    return row ? parse(row) : undefined;
  }
  /** Tasks dispatched for one workflow step, oldest first (each retry is a new task). */
  forWorkflowStep(workflowRunId: string, stepId: string, limit = 20): string[] {
    return this.db
      .prepare(`SELECT task_id FROM group_task_handoffs
      WHERE json_extract(spec,'$.workflowStep.workflowRunId')=?
      AND json_extract(spec,'$.workflowStep.stepId')=? ORDER BY created_at,task_id LIMIT ?`)
      .all(workflowRunId, stepId, Math.min(Math.max(limit, 1), 50))
      .map((row) => String(row.task_id));
  }
  create(input: {
    taskId: string;
    spec: HandoffSpec;
    pipeline: HandoffPipeline | null;
    baseFolder: string | null;
    returnOf?: string | null;
  }) {
    this.db
      .prepare(
        "INSERT INTO group_task_handoffs(task_id,spec,pipeline,base_folder,return_of,state,created_at) VALUES (?,?,?,?,?,'pending',?)",
      )
      .run(
        input.taskId,
        JSON.stringify(HandoffSpecSchema.parse(input.spec)),
        input.pipeline ? JSON.stringify(HandoffPipelineSchema.parse(input.pipeline)) : null,
        input.baseFolder,
        input.returnOf ?? null,
        new Date().toISOString(),
      );
  }
  /** First result wins: a late duplicate check never overwrites the one already acted on. */
  setResult(taskId: string, result: HandoffResult) {
    this.db
      .prepare("UPDATE group_task_handoffs SET result=? WHERE task_id=? AND result IS NULL")
      .run(JSON.stringify(HandoffResultSchema.parse(result)), taskId);
  }
  setState(taskId: string, state: HandoffState, wakeRunId?: string) {
    this.db
      .prepare(
        "UPDATE group_task_handoffs SET state=?,wake_run_id=COALESCE(?,wake_run_id) WHERE task_id=?",
      )
      .run(state, wakeRunId ?? null, taskId);
  }
  /** Keep the original checks and artifacts when the user accepts their remaining judgement. */
  confirmByUser(taskId: string) {
    const record = this.get(taskId);
    if (!record?.result) return;
    this.db
      .prepare("UPDATE group_task_handoffs SET result=? WHERE task_id=?")
      .run(JSON.stringify({ ...record.result, userResolved: true }), taskId);
  }
  /** Bounded display facts; absolute paths only when a checked location diagnostic needs them. */
  view(taskId: string): GroupTaskHandoff | undefined {
    const record = this.get(taskId);
    if (!record) return undefined;
    // Older accept decisions predate userResolved; the resolved card is the durable user fact.
    const userConfirmed =
      record.result?.userResolved === true ||
      !!this.db
        .prepare(`
      SELECT 1 FROM group_workflow_steps s JOIN messages m ON m.id=s.decision_message_id
      WHERE s.task_id=? AND s.status='passed'
      AND json_extract(m.usage,'$.groupWorkflowDecision.state')='resolved'
      AND json_extract(m.usage,'$.groupWorkflowDecision.resolution')='accept' LIMIT 1`)
        .get(taskId);
    return {
      workflow: record.spec.workflow?.name ?? null,
      files: record.spec.files,
      form: record.spec.form,
      acceptance: record.spec.acceptance.map((item) => ({ id: item.id, text: item.text ?? null })),
      condition: record.spec.condition,
      state: record.state,
      ...(userConfirmed ? { userConfirmed: true } : {}),
      returnOf: record.returnOf,
      items: record.result?.items ?? [],
      artifacts: (record.result?.artifacts ?? []).slice(0, HANDOFF_ARTIFACTS),
    };
  }
}
