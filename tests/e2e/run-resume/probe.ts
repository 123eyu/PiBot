import assert from "node:assert/strict";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ToolJournal } from "../../../packages/brain/src/runtime/tools/journal/journal.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { type Fixture, fixture, sessionEntries, until } from "../chat/harness.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";

const HOLD_A = "RUN-RESUME-HOLD-A";
const HOLD_B = "RUN-RESUME-HOLD-B";
const CONTENT = "续跑已写入的内容\n";
const FILE = "run-resume.txt";
const PROMPT_A = "RUN-RESUME-PROMPT-A 执行中断剧本";
const PROMPT_B = "RUN-RESUME-PROMPT-B 执行排队剧本";
const RESUMED = "RUN-RESUME-RESUMED 已核对，继续完成";
const NAME = "周期简报";
const BUDGET = { modelRequests: 20 };
const CONTRACT = {
  inputs: [{ name: "本期资料", kind: "folder", required: true }],
  deliverables: [{ id: "brief", path: "简报.md", kind: "md", sections: ["结论摘要", "来源"] }],
  acceptance: [
    { id: "a1", check: "exists", deliverable: "brief" },
    { id: "a2", check: "sections", deliverable: "brief" },
    { id: "a3", check: "manual", text: "结论与资料一致" },
  ],
  budget: BUDGET,
};
const SKILL = [
  "---",
  "name: periodic-brief",
  'description: "用一个文件夹的资料写周期简报。"',
  "metadata:",
  `  pibot-name: "${NAME}"`,
  '  pibot-version: "1"',
  `  pibot-contract: ${JSON.stringify(JSON.stringify(CONTRACT))}`,
  "---",
  "",
  `# ${NAME}`,
  "",
  "RUN-RESUME-WORKFLOW-BODY 浏览本期资料，写结论。",
  "",
].join("\n");

function today() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Holds every run_command carrying a marker "in flight": the journal decides and records it as
 * usual, then the dispatch never completes until the run is aborted. `executed` counts how often
 * the journal let such a command dispatch at all, across both brains of this process.
 */
function holdCommands() {
  const original = ToolJournal.prototype.run;
  let executed = 0;
  ToolJournal.prototype.run = function (context, prepared, signal, execute) {
    const command =
      prepared.call.tool === "run_command" ? String(prepared.call.input.command ?? "") : "";
    if (!command.includes(HOLD_A) && !command.includes(HOLD_B))
      return original.call(this, context, prepared, signal, execute);
    return original.call(this, context, prepared, signal, () => {
      executed++;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
  };
  return {
    executed: () => executed,
    restore: () => {
      ToolJournal.prototype.run = original;
    },
  };
}

async function approveAll(f: Fixture) {
  for (const card of await f.client.call("approvals.pending", {}))
    await f.client.call("approvals.resolve", { id: card.id, decision: "allow", remember: false });
}

function readDb<T>(f: Fixture, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(f.root, "data", "pibot.db"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * What a crash leaves on disk: the committed database and the session files as they are right
 * now. The returned step puts them back while no brain is open, so the graceful stop that follows
 * (which settles runs and journal rows) leaves no trace.
 */
async function crashSnapshot(f: Fixture, label: string) {
  const data = join(f.root, "data");
  const dir = join(f.root, `crash-${label}`);
  const sessions = join(data, "bots", f.researcher.id, "sessions");
  await mkdir(dir, { recursive: true });
  readDb(f, (db) => db.exec(`VACUUM INTO '${join(dir, "pibot.db").replaceAll("'", "''")}'`));
  await cp(sessions, join(dir, "sessions"), { recursive: true });
  return async () => {
    for (const suffix of ["", "-wal", "-shm"])
      await rm(join(data, `pibot.db${suffix}`), { force: true });
    await copyFile(join(dir, "pibot.db"), join(data, "pibot.db"));
    await rm(sessions, { recursive: true, force: true });
    await cp(join(dir, "sessions"), sessions, { recursive: true });
  };
}

async function settledRun(f: Fixture, conversationId: string, runId: string, label: string) {
  const rows = await until(
    label,
    async () => {
      await approveAll(f);
      const history = await f.client.call("chat.history", {
        botId: f.researcher.id,
        topicId: conversationId,
      });
      return history.filter((row) => row.role === "assistant" && row.runId === runId);
    },
    (rows) =>
      rows.length > 0 &&
      rows.every((row) => row.status !== "streaming") &&
      (rows.at(-1)?.usage as { stopReason?: string } | null)?.stopReason !== "continued",
  );
  const reply = rows.at(-1);
  assert(reply);
  return reply;
}

async function toolResults(root: string) {
  const texts: string[] = [];
  for (const entry of await sessionEntries(root)) {
    const message = entry.message as
      | { role?: string; content?: { type: string; text?: string }[] }
      | undefined;
    if (message?.role === "toolResult")
      texts.push((message.content ?? []).map((block) => block.text ?? "").join(""));
  }
  return texts;
}

/**
 * Interrupted and queued runs on one Bot and topic, across two crashes:
 * A. write_file (done), then run_command in flight when the process dies → after the restart the
 *    run is interrupted; 「继续」 resumes it: the write is answered from the journal (not redone),
 *    the command is refused as unknown (not rerun), and the model gets the runtime note.
 * B. run_command in flight with a workflow run queued behind it in the same topic → after the
 *    restart the workflow run comes back by itself and runs as the same workflow (body in the
 *    system prompt, delivery check on its receipt); the held run is interrupted, not resumed.
 */
export async function runResumeProbe(root: string) {
  const notes: string[] = [];
  const scenario: Scenario = { replies: [{ text: "未匹配到演练身份。" }], routes: {} };
  const f = await fixture(
    scenario,
    root,
    {},
    {},
    {
      onRequest(body) {
        const text = JSON.stringify(body.messages ?? body.input);
        // The tag followed by a line break is the state block; the system prompt only names it.
        const at = text.indexOf("<runResume>\\n");
        if (at >= 0) notes.push(text.slice(at, text.indexOf("</runResume>", at)));
      },
    },
  );
  const hold = holdCommands();
  try {
    const write = { name: "write_file", arguments: { path: FILE, content: CONTENT } };
    const command = (marker: string) => ({
      name: "run_command",
      arguments: { command: `echo ${marker}` },
    });
    const brief = `.pibot/out/${NAME}/${today()}/简报.md`;
    scenario.routes = {
      researcher: withToolDiscovery(
        [
          // A: before the crash.
          { toolCalls: [write] },
          { toolCalls: [command(HOLD_A)] },
          // A: the resumed run repeats both calls, then finishes.
          { toolCalls: [write] },
          { toolCalls: [command(HOLD_A)] },
          { text: RESUMED },
          // B: before the crash.
          { toolCalls: [command(HOLD_B)] },
          // B: the recovered workflow run.
          {
            toolCalls: [
              {
                name: "write_file",
                arguments: {
                  path: brief,
                  content: "# 简报\n\n## 结论摘要\n- 稳定\n\n## 来源\n[1] 资料\n",
                },
              },
            ],
          },
          { text: "RUN-RESUME-WORKFLOW 完成" },
        ],
        toolLoadGroup,
      ),
    };

    const source = join(f.root, "skill-src", "periodic-brief");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), SKILL);
    await mkdir(join(f.root, "资料"), { recursive: true });
    await writeFile(join(f.root, "资料", "notes.txt"), "synthetic\n");
    f.pickFolderNext(source);
    const preview = await f.client.call("skills.preview", {
      botId: f.researcher.id,
      from: "folder",
    });
    assert(preview);
    const skill = await f.client.call("skills.import", { previewId: preview.previewId });

    // ---- A. interrupted mid-command, then resumed.
    const a = await f.client.call("chat.send", { botId: f.researcher.id, text: PROMPT_A });
    assert(a.conversationId);
    await until(
      "命令执行中（A）",
      async () => {
        await approveAll(f);
        return hold.executed();
      },
      (n) => n === 1,
    );
    await f.restart(await crashSnapshot(f, "a"));

    const interrupted = readDb(f, (db) => ({
      run: db.prepare("SELECT status,stop_reason AS stopReason FROM runs WHERE id=?").get(a.runId),
      journal: db
        .prepare(
          "SELECT tool,effect_class AS effectClass,state FROM tool_executions WHERE run_id=? ORDER BY created_at",
        )
        .all(a.runId)
        .map((row) => `${row.tool}:${row.effectClass}:${row.state}`),
    }));
    assert.deepEqual({ ...interrupted.run }, { status: "aborted", stopReason: "interrupted" });
    assert.deepEqual(
      interrupted.journal,
      ["write_file:idempotent:done", "run_command:local_effect:unknown"],
      "崩溃前写入已完成、命令结果不明",
    );
    const bubble = (
      await f.client.call("chat.history", { botId: f.researcher.id, topicId: a.conversationId })
    ).find((row) => row.id === a.assistantMessageId);
    assert.equal(bubble?.status, "aborted");
    assert.equal((bubble?.usage as { stopReason?: string } | null)?.stopReason, "interrupted");
    const receiptA = await f.client.call("runs.receipt", { runId: a.runId });
    assert.equal(receiptA.uncertain?.total, 1, "收据列出结果不明的调用");
    assert.deepEqual(
      receiptA.uncertain?.items.map((item) => [item.tool, item.effectClass]),
      [["run_command", "local_effect"]],
    );

    const resumed = await f.client.call("runs.resume", {
      botId: f.researcher.id,
      conversationId: a.conversationId,
      runId: a.runId,
    });
    const again = await f.client.call("runs.resume", {
      botId: f.researcher.id,
      conversationId: a.conversationId,
      runId: a.runId,
    });
    assert.equal(again.runId, resumed.runId, "再点一次得到同一个运行");
    const replyR = await settledRun(f, a.conversationId, resumed.runId, "继续的运行终态");
    assert.equal(replyR.status, "done", `继续的运行：${replyR.errorCode ?? ""}`);
    assert.equal(hold.executed(), 1, "继续时不重跑结果不明的命令");
    assert.equal(await readFile(join(f.root, FILE), "utf8"), CONTENT);

    const audit = await f.client.call("audit.list", { botId: f.researcher.id, limit: 200 });
    const written = audit.filter(
      (e) => e.kind === "file.written" && String(e.detail.path ?? "").endsWith(FILE),
    );
    assert.equal(written.length, 1, "已完成的写入不重做");
    const blocked = audit
      .filter((e) => e.runId === resumed.runId && e.kind === "tool.journal.replay_blocked")
      .map((e) => `${e.detail.toolName}:${e.detail.reasonCode}`)
      .sort();
    assert.deepEqual(blocked, [
      "run_command:journal_replay_unknown",
      "write_file:journal_replay_verified",
    ]);
    const lifecycle = audit
      .filter((e) => e.kind === "run.interrupted" || e.kind === "run.resumed")
      .map((e) => ({
        kind: e.kind,
        runId: e.runId,
        target: e.detail.target ?? null,
        entryCount: e.detail.entryCount,
      }));
    assert.deepEqual(
      lifecycle.find((e) => e.kind === "run.interrupted"),
      { kind: "run.interrupted", runId: a.runId, target: null, entryCount: 1 },
    );
    assert.deepEqual(
      lifecycle.find((e) => e.kind === "run.resumed"),
      { kind: "run.resumed", runId: resumed.runId, target: a.runId, entryCount: 1 },
    );
    const recovery = readDb(f, (db) =>
      db
        .prepare(
          "SELECT root_run_id AS root,resumed_from AS resumedFrom FROM run_recovery WHERE run_id=?",
        )
        .get(resumed.runId),
    );
    assert.deepEqual(
      { ...recovery },
      { root: a.runId, resumedFrom: a.runId },
      "继续的运行沿用原预算根",
    );
    assert(notes.length > 0, "模型收到运行状态里的中断说明");
    assert(notes.every((note) => note.includes("run_command (local_effect)")));
    const results = await toolResults(f.root);
    assert(
      results.some((t) => t.includes("outcome is unknown, so it was not repeated")),
      "模型收到「结果不明，先检查」",
    );
    assert(
      results.some((t) => t.includes("already ran in this task")),
      "写入交还上次结果",
    );

    // ---- B. a queued workflow run survives the restart as a workflow run.
    const b = await f.client.call("chat.send", {
      botId: f.researcher.id,
      topicId: a.conversationId,
      text: PROMPT_B,
    });
    await until(
      "命令执行中（B）",
      async () => {
        await approveAll(f);
        return hold.executed();
      },
      (n) => n === 2,
    );
    const w = await f.client.call("skills.runWorkflow", {
      botId: f.researcher.id,
      skillId: skill.id,
      conversationId: a.conversationId,
      freshTopic: false,
      inputs: { 本期资料: join(f.root, "资料") },
    });
    assert(w.status === "started");
    const queued = readDb(f, (db) => ({
      run: db.prepare("SELECT status FROM runs WHERE id=?").get(w.runId)?.status,
      workflow: JSON.parse(
        String(
          db.prepare("SELECT workflow_json AS w FROM run_recovery WHERE run_id=?").get(w.runId)?.w,
        ),
      ),
    }));
    assert.equal(queued.run, "queued", "工作流排在被占用的话题后面");
    assert.deepEqual(queued.workflow.budget, BUDGET, "工作流身份带合同预算");
    const requestsBefore = f.requests.length;
    await f.restart(await crashSnapshot(f, "b"));

    const replyW = await settledRun(f, w.conversationId, w.runId, "恢复的工作流终态");
    assert.equal(replyW.status, "done", `恢复的工作流：${replyW.errorCode ?? ""}`);
    const runB = readDb(f, (db) =>
      db.prepare("SELECT status,stop_reason AS stopReason FROM runs WHERE id=?").get(b.runId),
    );
    assert.deepEqual({ ...runB }, { status: "aborted", stopReason: "interrupted" });
    assert.equal(hold.executed(), 2, "重启不会自动继续被中断的运行");
    const workflowRequests = f.requests
      .slice(requestsBefore)
      .filter((request) => request.route === "researcher");
    assert(
      workflowRequests.length > 0 && workflowRequests.every((r) => r.workflowChars > 0),
      "恢复的运行每次请求都带工作流正文",
    );
    const receiptW = await f.client.call("runs.receipt", { runId: w.runId });
    assert(receiptW.delivery, "恢复的工作流仍做交付检查");
    assert.deepEqual(
      receiptW.delivery.items.map((item) => [item.id, item.status]),
      [
        ["a1", "pass"],
        ["a2", "pass"],
        ["a3", "manual"],
      ],
    );

    const recorded = JSON.stringify([
      audit.filter((e) => e.kind.startsWith("run.") || e.kind.startsWith("tool.journal.")),
      receiptA,
      receiptW,
    ]);
    for (const secret of [CONTENT.trim(), PROMPT_A, PROMPT_B, RESUMED, HOLD_A, "synthetic-chat-key-only"])
      assert(!recorded.includes(secret), `审计与收据不得包含 ${secret}`);

    return {
      scenario: "中断与继续",
      status: "脚本化通过",
      interrupted: { run: interrupted.run, journal: interrupted.journal },
      receiptUncertain: receiptA.uncertain,
      resume: {
        replayBlocked: blocked,
        commandDispatches: hold.executed(),
        fileWrites: written.length,
        notesSeen: notes.length,
      },
      lifecycleAudit: lifecycle.map((e) => e.kind),
      queuedWorkflow: {
        recovered: replyW.status,
        modelRequests: workflowRequests.length,
        workflowBlockChars: workflowRequests[0]?.workflowChars ?? 0,
        delivery: receiptW.delivery.status,
      },
      nonFixtureNetworkAttempts: f.blocked(),
    };
  } finally {
    hold.restore();
    await f.cleanup();
  }
}
