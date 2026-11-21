import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { WorkflowStep } from "../../../packages/protocol/src/index.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { type Fixture, fixture, until } from "../chat/harness.ts";

function today() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function write(path: string, content: string) {
  return { toolCalls: [{ name: "write_file", arguments: { path, content } }] };
}

function output(name: string, file: string) {
  return `.pibot/out/${name}/${today()}/${file}`;
}

const requestCount = (f: Fixture) => Object.values(f.counts()).reduce((sum, count) => sum + count, 0);

function readDb<T>(f: Fixture, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(f.root, "data", "pibot.db"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function writeDb<T>(f: Fixture, write: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(f.root, "data", "pibot.db"));
  try {
    return write(db);
  } finally {
    db.close();
  }
}

async function approveAll(f: Fixture) {
  for (const card of await f.client.call("approvals.pending", {}))
    await f.client.call("approvals.resolve", {
      id: card.id,
      decision: "allow",
      remember: false,
    });
}

type StepRow = {
  step_id: string;
  status: string;
  attempt: number;
  owner_bot_id: string;
  task_id: string | null;
  execution_run_id: string | null;
  decision_message_id: string | null;
};

function runIdFor(f: Fixture, skillId: string) {
  return readDb(f, (db) =>
    String(
      (
        db
          .prepare(
            "SELECT id FROM group_workflow_runs WHERE skill_id=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(skillId) as { id?: string } | undefined
      )?.id ?? "",
    ),
  );
}

function stepsFor(f: Fixture, workflowRunId: string) {
  return readDb(f, (db) =>
    db
      .prepare(
        `SELECT step_id,status,attempt,owner_bot_id,task_id,execution_run_id,decision_message_id
         FROM group_workflow_steps WHERE workflow_run_id=? ORDER BY rowid`,
      )
      .all(workflowRunId) as unknown as StepRow[],
  );
}

async function waitForStep(
  f: Fixture,
  workflowRunId: string,
  stepId: string,
  status: string,
) {
  try {
    return await until(
      `${stepId} -> ${status}`,
      async () => {
        await approveAll(f);
        return stepsFor(f, workflowRunId).find((step) => step.step_id === stepId);
      },
      (step) => step?.status === status,
    );
  } catch (error) {
    const states = stepsFor(f, workflowRunId).map((step) => ({
      id: step.step_id,
      status: step.status,
      attempt: step.attempt,
      task: !!step.task_id,
      run: !!step.execution_run_id,
      execution: step.execution_run_id ? readDb(f, (db) => db.prepare("SELECT status,error_code,stop_reason FROM runs WHERE id=?").get(step.execution_run_id)) : null,
      taskStatus: step.task_id ? readDb(f, (db) => db.prepare("SELECT status FROM group_tasks WHERE id=?").get(step.task_id)) : null,
      check: step.task_id ? readDb(f, (db) => db.prepare("SELECT json_extract(result,'$.unavailable') AS unavailable,state FROM group_task_handoffs WHERE task_id=?").get(step.task_id)) : null,
    }));
    throw new Error(`${error instanceof Error ? error.message : "timeout"}; ${JSON.stringify(states)}; counts=${JSON.stringify(f.counts())}`);
  }
}

async function createAndRun(
  f: Fixture,
  name: string,
  steps: WorkflowStep[],
  maxFixRounds: number,
  costCapUsd?: number,
  modelRequests = 20,
) {
  const skill = await f.client.call("skills.createWorkflow", {
    botId: f.main.id,
    groupId: f.group.id,
    requestId: crypto.randomUUID(),
    document: {
      name,
      description: `${name} 合成验收`,
      body: `# ${name}\n\n按步骤合同执行。`,
      params: [],
      contract: {
        inputs: [{ name: "reference", kind: "text", required: true }],
        prechecks: [],
        deliverables: [],
        acceptance: [],
        stop: [],
        maxFixRounds,
        approvals: [],
        budget: {
          modelRequests,
          activeSeconds: 600,
          ...(costCapUsd === undefined ? {} : { costUsd: 10 }),
        },
        steps,
      },
    },
  });
  const started = await f.client.call("skills.runWorkflow", {
    botId: f.main.id,
    groupId: f.group.id,
    skillId: skill.id,
    params: {},
    inputs: { reference: "ACTUAL-BOUND-INPUT" },
    ...(costCapUsd === undefined ? {} : { costCapUsd }),
    freshTopic: false,
  });
  assert.equal(started.status, "started");
  const workflowRunId = runIdFor(f, skill.id);
  assert(workflowRunId, "durable workflow run created");
  return workflowRunId;
}

const deliverable = (id: string, path: string) => ({ id, path, kind: "md" as const });
const exists = (id: string, target: string) => ({
  id,
  check: "exists" as const,
  deliverable: target,
});

export async function runGroupWorkflowProbe(root: string) {
  const twoStep = "两步依赖";
  const retry = "失败重试";
  const manualRetry = "用户重试";
  const skip = "重启跳过";
  const reassign = "失败改派";
  const scenario: Scenario = {
    replies: [{ text: "未匹配到演练身份。" }],
    routes: {
      researcher: [
        write(output(twoStep, "data.md"), "# data\nready\n"),
        { text: "TWO-STEP-DATA-DONE" },
        { text: "RETRY-FIRST-FAIL" },
        write(output(retry, "retry.md"), "# retry\nfixed\n"),
        { text: "RETRY-FIXED" },
        { text: "MANUAL-RETRY-FIRST-FAIL" },
        { text: "MANUAL-RETRY-SECOND-FAIL" },
        write(output(manualRetry, "manual-retry.md"), "# retry\nuser requested\n"),
        { text: "MANUAL-RETRY-FIXED" },
        { text: "SKIP-BEFORE-RESTART-FAIL" },
        { text: "REASSIGN-FIRST-FAIL" },
        write("__CONTRACT__", "# manual\nready\n"),
        { text: "MANUAL-CHECK-DONE" },
        { text: "UNAVAILABLE-CHECK-DONE", pauseMs: 3000, delayMs: 0 },
        { text: "CANCEL-WHILE-RUNNING", hang: true },
        { text: "OLD-CYCLE-DONE", pauseMs: 3000, delayMs: 0 },
        { text: "NEW-CYCLE-RETRY-DONE" },
        write("__CONTRACT__", "# budget\nfirst request wrote; the next model admission must stop\n"),
        { text: "CLAIMED-WAKE-PASS", pauseMs: 3000, delayMs: 0 },
        { text: "CLAIMED-WAKE-FAIL", pauseMs: 3000, delayMs: 0 },
      ],
      writer: [
        write(output(twoStep, "report.md"), "# report\nfrom data\n"),
        { text: "TWO-STEP-REPORT-DONE" },
        write(output(skip, "after-skip.md"), "# after skip\ncontinued\n"),
        { text: "SKIP-DOWNSTREAM-DONE" },
        write(output(reassign, "reassigned.md"), "# reassigned\ndone\n"),
        { text: "REASSIGNED-DONE" },
        { text: "MANUAL-DOWNSTREAM-DONE" },
      ],
    },
  };
  let contractPrompts = 0;
  let retryPrompts = 0;
  const f = await fixture(scenario, root, {}, {}, { onRequest(body, route, index) {
    const strings: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(body.messages ?? body.input);
    const text = strings.join("\n");
    const folder = /产物目录 \/ Output folder:\n([^\n]+)/.exec(text)?.[1];
    const contractText = /交付合同 \/ Delivery contract:\n([^\n]+)/.exec(text)?.[1];
    if (folder && contractText) {
      assert(text.includes("ACTUAL-BOUND-INPUT"), "member receives the actual bound input");
      assert(text.includes("acceptance"), "member receives acceptance criteria");
      contractPrompts++;
    }
    // The reason-code dump was replaced with one shared correction text per failed check;
    // a step retry carries it for the missing deliverable.
    if (contractText && (text.includes("文件不存在") || text.includes("file does not exist")))
      retryPrompts++;
    const reply = scenario.routes?.[route]?.[index];
    for (const call of reply?.toolCalls ?? []) {
      if (call.name !== "write_file") continue;
      assert(folder && contractText, "fake model derives its output path from the actual member prompt");
      const contract = JSON.parse(contractText) as { deliverables: { path: string }[] };
      assert(contract.deliverables[0], "actual prompt names the required output");
      call.arguments.path = join(folder, contract.deliverables[0].path);
    }
  } });
  let stage = "configure group folder";
  try {
    f.pickFolderNext(f.root);
    const withFolder = await f.client.call("groups.folders.add", { groupId: f.group.id });
    const groupFolder = withFolder.folders?.find((folder) => folder.path === f.root);
    assert(groupFolder, "group output folder added");
    await f.client.call("groups.folders.setPrimary", {
      groupId: f.group.id,
      folderId: groupFolder.id,
    });
    stage = "two-step dependency";
    const runTwo = await createAndRun(
      f,
      twoStep,
      [
        {
          id: "data",
          title: "准备数据",
          owner: { botId: f.researcher.id },
          task: "准备数据文件。",
          dependsOn: [],
          deliverables: [deliverable("data-file", "data.md")],
          acceptance: [exists("data-exists", "data-file")],
        },
        {
          id: "report",
          title: "撰写报告",
          owner: { botId: f.writer.id },
          task: "读取前置交付物与交接摘要，撰写报告。",
          dependsOn: ["data"],
          deliverables: [deliverable("report-file", "report.md")],
          acceptance: [exists("report-exists", "report-file")],
        },
      ],
      0,
    );
    await waitForStep(f, runTwo, "report", "passed");
    const ordered = stepsFor(f, runTwo);
    const dataRun = ordered.find((step) => step.step_id === "data")?.execution_run_id;
    const reportRun = ordered.find((step) => step.step_id === "report")?.execution_run_id;
    assert(dataRun && reportRun, "both dependency runs persisted");
    const afterRunId = readDb(f, (db) =>
      (db.prepare("SELECT after_run_id FROM runs WHERE id=?").get(reportRun) as {
        after_run_id?: string;
      }).after_run_id,
    );
    assert.equal(afterRunId, dataRun, "dependency is also expressed through after_run_id");
    const budgetRoot = readDb(f, (db) => {
      const workflow = db
        .prepare("SELECT budget_root_run_id AS root FROM group_workflow_runs WHERE id=?")
        .get(runTwo) as { root?: string };
      const child = db
        .prepare("SELECT root_run_id AS root FROM run_recovery WHERE run_id=?")
        .get(reportRun) as { root?: string };
      return { workflow: workflow.root, child: child.root };
    });
    assert.equal(budgetRoot.workflow, dataRun, "first step is the durable workflow budget root");
    assert.equal(budgetRoot.child, dataRun, "dependent step uses the shared workflow budget root");
    const [dataReceipt, reportReceipt] = await Promise.all([
      f.client.call("runs.receipt", { runId: dataRun }),
      f.client.call("runs.receipt", { runId: reportRun }),
    ]);
    assert.equal(
      dataReceipt.cost?.requests,
      reportReceipt.cost?.requests,
      "both step receipts summarize the shared budget root",
    );
    assert((dataReceipt.cost?.requests ?? 0) >= 2, "shared receipt includes both step requests");

    stage = "automatic retry";
    const runRetry = await createAndRun(
      f,
      retry,
      [
        {
          id: "retry",
          title: "失败后修正",
          owner: { botId: f.researcher.id },
          task: "交付 retry.md。",
          dependsOn: [],
          deliverables: [deliverable("retry-file", "retry.md")],
          acceptance: [exists("retry-exists", "retry-file")],
        },
      ],
      1,
    );
    const retried = await waitForStep(f, runRetry, "retry", "passed");
    // The missing file is corrected inside the first run (the shared correction text
    // counted in retryPrompts), so the step passes without a fresh attempt.
    assert.equal(retried?.attempt, 0, "the failed check was corrected inside the same run");

    stage = "user retry disposition";
    const runManualRetry = await createAndRun(
      f,
      manualRetry,
      [
        {
          id: "manual-retry",
          title: "由用户决定重试",
          owner: { botId: f.researcher.id },
          task: "交付 manual-retry.md。",
          dependsOn: [],
          deliverables: [deliverable("manual-retry-file", "manual-retry.md")],
          acceptance: [exists("manual-retry-exists", "manual-retry-file")],
        },
      ],
      0,
    );
    const firstManualBlock = await waitForStep(f, runManualRetry, "manual-retry", "blocked");
    await f.client.call("groups.workflow.resolve", {
      groupId: f.group.id,
      workflowRunId: runManualRetry,
      stepId: "manual-retry",
      action: "retry",
      confirmed: true,
    });
    const blockedAgain = await waitForStep(f, runManualRetry, "manual-retry", "blocked");
    assert.notEqual(
      blockedAgain?.decision_message_id,
      firstManualBlock?.decision_message_id,
      "a second failure creates another decision card",
    );
    await f.client.call("groups.workflow.resolve", {
      groupId: f.group.id,
      workflowRunId: runManualRetry,
      stepId: "manual-retry",
      action: "retry",
      confirmed: true,
    });
    const manuallyRetried = await waitForStep(f, runManualRetry, "manual-retry", "passed");
    assert.equal(manuallyRetried?.attempt, 2);

    stage = "restart then skip";
    const runSkip = await createAndRun(
      f,
      skip,
      [
        {
          id: "optional",
          title: "可跳过步骤",
          owner: { botId: f.researcher.id },
          task: "尝试交付 optional.md。",
          dependsOn: [],
          deliverables: [deliverable("optional-file", "optional.md")],
          acceptance: [exists("optional-exists", "optional-file")],
        },
        {
          id: "after-skip",
          title: "跳过后继续",
          owner: { botId: f.writer.id },
          task: "即使前置被跳过也继续。",
          dependsOn: ["optional"],
          deliverables: [deliverable("after-skip-file", "after-skip.md")],
          acceptance: [exists("after-skip-exists", "after-skip-file")],
        },
      ],
      0,
    );
    const blockedSkip = await waitForStep(f, runSkip, "optional", "blocked");
    assert(blockedSkip?.decision_message_id, "failed step persisted a decision card");
    stage = "seed paged recovery";
    writeDb(f, (db) => {
      const insert = db.prepare(
        `INSERT INTO group_workflow_runs(
          id,group_id,skill_id,contract_version,status,initiator_bot_id,coordinator_bot_id,
          cycle_id,source_message_id,budget_root_run_id,workflow_json,created_at,updated_at,finished_at)
        SELECT ?,group_id,skill_id,contract_version,'waiting',initiator_bot_id,coordinator_bot_id,
          cycle_id,source_message_id,NULL,workflow_json,created_at,updated_at,NULL
        FROM group_workflow_runs WHERE id=?`,
      );
      const insertSteps = db.prepare(
        `INSERT INTO group_workflow_steps(
          workflow_run_id,step_id,status,attempt,task_id,execution_run_id,deliverables_json,
          owner_bot_id,decision_message_id,updated_at)
        SELECT ?,step_id,'blocked',attempt,NULL,NULL,'[]',owner_bot_id,NULL,updated_at
        FROM group_workflow_steps WHERE workflow_run_id=?`,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < 101; index++) {
          const id = crypto.randomUUID();
          insert.run(id, runSkip);
          insertSteps.run(id, runSkip);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    stage = "restart blocked workflow";
    await f.restart();
    stage = "skip after restart";
    await f.client.call("groups.workflow.resolve", {
      groupId: f.group.id,
      workflowRunId: runSkip,
      stepId: "optional",
      action: "skip",
      confirmed: true,
    });
    stage = "wait downstream after skip";
    await waitForStep(f, runSkip, "after-skip", "passed");
    assert.equal(stepsFor(f, runSkip)[0]?.status, "skipped");

    stage = "reassign";
    const runReassign = await createAndRun(
      f,
      reassign,
      [
        {
          id: "handover",
          title: "失败后改派",
          owner: { botId: f.researcher.id },
          task: "交付 reassigned.md。",
          dependsOn: [],
          deliverables: [deliverable("reassigned-file", "reassigned.md")],
          acceptance: [exists("reassigned-exists", "reassigned-file")],
        },
      ],
      0,
    );
    await waitForStep(f, runReassign, "handover", "blocked");
    await f.client.call("groups.workflow.resolve", {
      groupId: f.group.id,
      workflowRunId: runReassign,
      stepId: "handover",
      action: "reassign",
      ownerBotId: f.writer.id,
      confirmed: true,
    });
    const reassigned = await waitForStep(f, runReassign, "handover", "passed");
    assert.equal(reassigned?.attempt, 1);
    assert.equal(reassigned?.owner_bot_id, f.writer.id);

    stage = "unpriced model respects whole-plan cost cap";
    const beforeCap = requestCount(f);
    const runCapped = await createAndRun(f, "未知价格闭锁", [{
      id: "capped",
      title: "预算闭锁",
      owner: { botId: f.researcher.id },
      task: "不得绕过本次费用上限。",
      dependsOn: [],
      deliverables: [],
      acceptance: [],
    }], 0, 5);
    const capped = await waitForStep(f, runCapped, "capped", "blocked");
    assert(capped?.decision_message_id, "unpriced model creates an explicit disposition card");
    assert.equal(requestCount(f), beforeCap, "unknown prices cannot silently disable the confirmed cap");

    stage = "manual acceptance is confirmed once after downstream execution";
    const manual = await createAndRun(f, "人工验收", [
      { id: "manual", title: "人工核对", owner: { botId: f.researcher.id }, task: "准备产物。", dependsOn: [], deliverables: [deliverable("manual-file", "manual.md")], acceptance: [{ id: "manual-review", check: "manual", text: "请用户核对" }] },
      { id: "after-manual", title: "确认后执行", owner: { botId: f.writer.id }, task: "在前置确认后执行。", dependsOn: ["manual"], deliverables: [], acceptance: [] },
    ], 0);
    await waitForStep(f, manual, "manual", "passed");
    await waitForStep(f, manual, "after-manual", "passed");
    await until("final manual review card", async () => readDb(f, (db) => db.prepare("SELECT id FROM messages WHERE json_extract(usage,'$.groupWorkflowDecision.workflowRunId')=? AND json_extract(usage,'$.groupWorkflowDecision.reasonCode')='plan_manual_review'").get(manual)), Boolean);
    await f.client.call("groups.workflow.resolve", { groupId: f.group.id, workflowRunId: manual, stepId: "manual", action: "accept", confirmed: true });
    await waitForStep(f, manual, "after-manual", "passed");

    const simple = (id: string): WorkflowStep => ({ id, title: id, owner: { botId: f.researcher.id }, task: "执行当前步骤。", dependsOn: [], deliverables: [], acceptance: [] });
    stage = "unavailable check cannot pass automatically";
    const unavailable = await createAndRun(f, "检查不可用", [simple("unavailable")], 0);
    const unchecked = await waitForStep(f, unavailable, "unavailable", "running");
    assert(unchecked?.task_id);
    // Fault-inject the checker's durable timeout result while the real fake-model run is active.
    writeDb(f, (db) => db.prepare("UPDATE group_task_handoffs SET result=? WHERE task_id=? AND result IS NULL").run(JSON.stringify({ items: [], artifacts: [], durationMs: 30000, unavailable: true }), unchecked.task_id));
    await waitForStep(f, unavailable, "unavailable", "blocked");
    await f.client.call("groups.workflow.resolve", { groupId: f.group.id, workflowRunId: unavailable, stepId: "unavailable", action: "accept", confirmed: true });
    assert.equal(stepsFor(f, unavailable)[0]?.status, "passed");

    stage = "live cancellation is reconciled without restart";
    const beforeCancel = f.counts().researcher ?? 0;
    const cancelled = await createAndRun(f, "运行取消", [simple("cancel")], 0);
    const cancelling = await waitForStep(f, cancelled, "cancel", "running");
    assert(cancelling?.execution_run_id);
    await until("fake model started cancellation response", async () => f.counts().researcher ?? 0, (value) => value > beforeCancel);
    await f.client.call("chat.abort", { runId: cancelling.execution_run_id });
    const cancelledStep = await waitForStep(f, cancelled, "cancel", "blocked");
    assert(cancelledStep?.decision_message_id);
    await assert.rejects(f.client.call("groups.workflow.resolve", { groupId: f.group.id, workflowRunId: cancelled, stepId: "cancel", action: "accept", confirmed: true }), "cancelled work cannot be accepted as a manual check");
    await f.client.call("groups.workflow.resolve", { groupId: f.group.id, workflowRunId: cancelled, stepId: "cancel", action: "skip", confirmed: true });

    stage = "replaced cycle is surfaced and retry joins the current cycle";
    const beforeReplace = f.counts().researcher ?? 0;
    const replaced = await createAndRun(f, "替换周期", [simple("cycle")], 0);
    await waitForStep(f, replaced, "cycle", "running");
    await until("old cycle model started", async () => f.counts().researcher ?? 0, (value) => value > beforeReplace);
    await f.client.call("chat.send", { groupId: f.group.id, text: "新的群请求。", mentions: [f.main.id] });
    await waitForStep(f, replaced, "cycle", "blocked");
    await f.client.call("groups.workflow.resolve", { groupId: f.group.id, workflowRunId: replaced, stepId: "cycle", action: "retry", confirmed: true });
    await waitForStep(f, replaced, "cycle", "passed");

    stage = "budget interrupted run becomes actionable without restart";
    const exhausted = await createAndRun(f, "请求预算耗尽", [{ ...simple("budget"), deliverables: [deliverable("budget-file", "budget.md")], acceptance: [exists("budget-exists", "budget-file")] }], 0, undefined, 1);
    const budgetStopped = await waitForStep(f, exhausted, "budget", "blocked");
    assert(budgetStopped?.decision_message_id);
    assert(budgetStopped?.execution_run_id, "this budget block happened after dispatch");
    assert.equal(readDb(f, (db) => db.prepare("SELECT status FROM runs WHERE id=?").get(budgetStopped.execution_run_id)?.status), "error", "budget interruption is a real failed execution");

    stage = "DAG settlement is independent of a drained completion wake";
    const claimedTasks: string[] = [];
    for (const outcome of ["passed", "blocked"] as const) {
      const definition = outcome === "passed" ? simple("claimed-pass") : {
        ...simple("claimed-fail"),
        deliverables: [deliverable("unwritten", "unwritten.md")],
        acceptance: [exists("unwritten-check", "unwritten")],
      };
      const plan = await createAndRun(f, `已认领唤醒 ${outcome}`, [definition], 0);
      const running = await waitForStep(f, plan, definition.id, "running");
      assert(running?.task_id);
      // Reproduce drainInteractive's durable claim before a stable handoff result exists.
      // This injects only the wake state; the child execution and checker still run normally.
      const changed = writeDb(f, (db) => db.prepare("UPDATE group_task_origins SET wake_claimed=1 WHERE task_id=? AND wake_claimed=0").run(running.task_id));
      assert.equal(Number(changed.changes), 1);
      const settled = await waitForStep(f, plan, definition.id, outcome);
      if (outcome === "blocked") assert(settled?.decision_message_id);
      claimedTasks.push(running.task_id);
    }
    assert(contractPrompts > 5, "actual member prompts carried inputs/folders/contracts");
    assert(retryPrompts > 0, "a corrective attempt received previous unmet checks");

    stage = "audit assertions";
    const audits = readDb(f, (db) =>
      db
        .prepare(
          `SELECT kind,detail FROM audit_log
           WHERE kind LIKE 'group.workflow.%' ORDER BY at,id`,
        )
        .all() as unknown as { kind: string; detail: string }[],
    );
    const kinds = new Set(audits.map((entry) => entry.kind));
    for (const taskId of claimedTasks)
      assert.equal(audits.filter((entry) => ["group.workflow.step_passed", "group.workflow.step_failed"].includes(entry.kind) && JSON.parse(entry.detail).taskId === taskId).length, 1, "preclaimed wake settles and audits each DAG attempt exactly once");
    // The engine migrations are audited only on installs that already had groups;
    // this probe starts from a new data folder, so none is audited, before or after the restart.
    assert.equal(
      audits.filter((entry) => entry.kind === "group.workflow.migrated").length,
      0,
      "a new install audits no engine migration, also across restart",
    );
    assert(
      audits.filter((entry) => entry.kind === "group.workflow.recovered").length >= 102,
      "startup recovery scans beyond the first 100 active workflows",
    );
    for (const required of [
      "group.workflow.started",
      "group.workflow.recovered",
      "group.workflow.step_dispatched",
      "group.workflow.step_failed",
      "group.workflow.step_passed",
      "group.workflow.disposition",
      "group.workflow.completed",
    ])
      assert(kinds.has(required), `audit kind ${required}`);
    // User decisions carry workflowAction; a confirmed manual check records reasonCode
    // user_confirmed (its accept), and the system's hand-over to the user carries neither.
    const actions = audits
      .filter((entry) => entry.kind === "group.workflow.disposition")
      .map((entry) => JSON.parse(entry.detail) as { workflowAction?: string; reasonCode?: string })
      .filter((detail) => detail.workflowAction || detail.reasonCode === "user_confirmed")
      .map((detail) => detail.workflowAction ?? "accept");
    assert.deepEqual(actions, ["retry", "retry", "skip", "reassign", "accept", "accept", "skip", "retry"]);
    stage = "group deletion clears DAG foreign keys before source messages";
    await f.client.call("groups.delete", { groupId: f.group.id, confirmed: true });
    assert.equal(readDb(f, (db) => db.prepare("SELECT COUNT(*) AS n FROM group_workflow_runs WHERE group_id=?").get(f.group.id)?.n), 0);
    assert.equal(readDb(f, (db) => db.prepare("SELECT COUNT(*) AS n FROM group_workflow_steps").get()?.n), 0);
    assert.deepEqual(readDb(f, (db) => db.prepare("PRAGMA foreign_key_check").all()), []);
    assert.equal(f.blocked(), 0, "probe made no external network request");
    return {
      workflows: 13,
      preclaimedWakeSettlements: claimedTasks.length,
      contractPrompts,
      retryPrompts,
      dependencySteps: ordered.length,
      retryAttempts: retried?.attempt,
      dispositions: actions.length,
      recoveryAudits: audits.filter((entry) => entry.kind === "group.workflow.recovered").length,
      modelRequests: requestCount(f),
    };
  } catch (error) {
    throw new Error(
      `group workflow probe failed at ${stage}: ${error instanceof Error ? error.message : "unknown"}`,
      { cause: error },
    );
  } finally {
    await f.cleanup();
  }
}
