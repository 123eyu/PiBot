import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { type Fixture, fixture, until } from "../chat/harness.ts";

const NAME = "周期简报";
const BODY_MARKER = "WORKFLOW-BODY-MARKER";
const CONTRACT = {
  inputs: [
    { name: "本期资料", kind: "folder", required: true },
    { name: "上期产物", kind: "previous" },
  ],
  prechecks: [{ check: "nonEmpty", input: "本期资料" }],
  deliverables: [{ id: "brief", path: "简报.md", kind: "md", sections: ["结论摘要", "来源"] }],
  acceptance: [
    { id: "a1", check: "exists", deliverable: "brief" },
    { id: "a2", check: "sections", deliverable: "brief" },
    { id: "a3", check: "citations", deliverable: "brief" },
    { id: "a4", check: "manual", text: "结论与资料一致" },
    { id: "a5", check: "minCitations", deliverable: "brief", min: 1 },
    { id: "a6", check: "sectionsSourced", deliverable: "brief" },
    { id: "a7", check: "tableColumns", deliverable: "brief", columns: ["指标", "数值"] },
  ],
  stop: ["不编造数字"],
  maxFixRounds: 2,
  state: { readPrevious: true },
  budget: { costUsd: 1 },
  model: { tier: "main", thinking: "low" },
};
const SKILL = [
  "---",
  "name: periodic-brief",
  'description: "用一个文件夹的资料写周期简报。"',
  "metadata:",
  `  pibot-name: "${NAME}"`,
  '  pibot-version: "1"',
  `  pibot-params: ${JSON.stringify(JSON.stringify([{ name: "主题", default: "本期进展" }]))}`,
  `  pibot-contract: ${JSON.stringify(JSON.stringify(CONTRACT))}`,
  "---",
  "",
  `# ${NAME}`,
  "",
  `${BODY_MARKER} 主题：{主题}`,
  "1. 浏览本期资料。",
  "2. 写结论，标来源编号 [n]。",
  "",
].join("\n");

function today() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Waits for the run's reply to settle, answering every approval card with "allow once". */
async function settled(f: Fixture, conversationId: string, messageId: string) {
  let approved = 0;
  const segments = await until(
    "工作流回复终态",
    async () => {
      for (const approval of await f.client.call("approvals.pending", {})) {
        await f.client.call("approvals.resolve", {
          id: approval.id,
          decision: "allow",
          remember: false,
        });
        approved++;
      }
      const rows = await f.client.call("chat.history", {
        botId: f.researcher.id,
        topicId: conversationId,
      });
      const first = rows.find((row) => row.id === messageId);
      // A fix round continues the run in a new reply segment; the run ends with its last one.
      return rows.filter((row) => row.role === "assistant" && first && row.runId === first.runId);
    },
    (segments) =>
      segments.length > 0 &&
      segments.every((row) => row.status !== "streaming") &&
      (segments.at(-1)?.usage as { stopReason?: string } | null)?.stopReason !== "continued",
  );
  const reply = segments.at(-1);
  assert(reply?.runId, "回复带运行 ID");
  return { reply, approved, segments: segments.length };
}

/**
 * One workflow skill imported through the real picker path, then three runs:
 * pre-check failure (nothing starts), a draft that misses a section and is fixed in one delivery
 * round, and a draft that stays failing after the two allowed rounds (交付未通过).
 */
export async function runWorkflowProbe(root: string) {
  const folder = `.pibot/out/${NAME}/${today()}`;
  const brief = `${folder}/简报.md`;
  const incomplete = "# 周期简报\n\n## 结论摘要\n- 收入增长 [1]\n";
  const complete = `${incomplete}\n| 指标 | 数值 |\n| --- | --- |\n| 收入 | 120 |\n\n## 来源\n[1] 资料/sales.csv\n`;
  const scenario: Scenario = {
    replies: [{ text: "未匹配到演练身份。" }],
    routes: {
      researcher: [
        // Run A: first draft misses 来源 → one fix round → complete.
        { toolCalls: [{ name: "write_file", arguments: { path: brief, content: incomplete } }] },
        { text: "WORKFLOW-A 第一稿" },
        { toolCalls: [{ name: "write_file", arguments: { path: brief, content: complete } }] },
        { text: "WORKFLOW-A 已补齐" },
        // Run B: the same miss, and both fix rounds change nothing.
        { toolCalls: [{ name: "write_file", arguments: { path: brief, content: incomplete } }] },
        { text: "WORKFLOW-B 第一稿" },
        { text: "WORKFLOW-B 修复 1" },
        { text: "WORKFLOW-B 修复 2" },
      ],
    },
  };
  const f = await fixture(scenario, root);
  try {
    const source = join(f.root, "skill-src", "periodic-brief");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), SKILL);
    await mkdir(join(f.root, "资料"), { recursive: true });
    await writeFile(join(f.root, "资料", "sales.csv"), "month,revenue\n9,100\n10,120\n");
    await mkdir(join(f.root, "空资料"), { recursive: true });
    f.pickFolderNext(source);
    const preview = await f.client.call("skills.preview", {
      botId: f.researcher.id,
      from: "folder",
    });
    assert(preview, "技能预览");
    assert.equal(preview.document.version, 1, "导入保留 pibot-version");
    assert(preview.document.contract, "导入保留 pibot-contract");
    const skill = await f.client.call("skills.import", { previewId: preview.previewId });

    const listed = await f.client.call("skills.workflows", { botId: f.researcher.id });
    const workflow = listed.items.find((item) => item.skillId === skill.id);
    assert(workflow?.contract, "skills.workflows 列出合同");
    assert.deepEqual(workflow.warnings, [], "合同无告警");
    assert.deepEqual(
      workflow.contract.inputs.map((input) => input.name),
      ["本期资料", "上期产物"],
      "表单输入来自合同",
    );

    // 1. Pre-checks: nothing is sent and no model request is made.
    const before = f.requests.length;
    const missing = await f.client.call("skills.runWorkflow", {
      botId: f.researcher.id,
      skillId: skill.id,
    });
    const empty = await f.client.call("skills.runWorkflow", {
      botId: f.researcher.id,
      skillId: skill.id,
      inputs: { 本期资料: join(f.root, "空资料") },
    });
    assert.equal(missing.status, "blocked");
    assert.equal(empty.status, "blocked");
    assert(missing.status === "blocked" && empty.status === "blocked");
    assert.deepEqual(missing.failures, [{ input: "本期资料", reason: "required" }]);
    assert.deepEqual(empty.failures, [{ input: "本期资料", reason: "empty" }]);
    await wait(200);
    assert.equal(f.requests.length, before, "前置检查失败不启动模型");
    const historyBefore = await f.client.call("chat.history", { botId: f.researcher.id });
    assert(!historyBefore.some((row) => row.content.includes(NAME)), "前置检查失败不发消息");

    // 2. Run A: one fix round, then every automatic item passes (the manual one stays listed).
    const startA = f.requests.length;
    const a = await f.client.call("skills.runWorkflow", {
      botId: f.researcher.id,
      skillId: skill.id,
      params: { 主题: "收入" },
      inputs: { 本期资料: join(f.root, "资料") },
    });
    assert(a.status === "started", "运行 A 已启动");
    const runA = await settled(f, a.conversationId, a.assistantMessageId);
    assert.equal(runA.reply.status, "done", `运行 A: ${runA.reply.errorCode ?? ""}`);
    await wait(300);
    const receiptA = await f.client.call("runs.receipt", { runId: a.runId });
    assert(receiptA.delivery, "收据带交付检查");
    assert.equal(receiptA.delivery.fixRounds, 1, "运行 A 修复一轮");
    assert.equal(receiptA.delivery.status, "manual", "自动项通过，人工项待确认");
    assert.deepEqual(
      receiptA.delivery.items.map((item) => [item.id, item.status]),
      [
        ["a1", "pass"],
        ["a2", "pass"],
        ["a3", "pass"],
        ["a4", "manual"],
        ["a5", "pass"],
        ["a6", "pass"],
        ["a7", "pass"],
      ],
    );
    assert.equal(receiptA.delivery.version, 1);
    assert.equal(await readFile(join(f.root, brief), "utf8"), complete, "修复后的文件");
    const requestsA = f.requests.slice(startA).filter((request) => request.route === "researcher");
    assert(
      requestsA.length > 0 && requestsA.every((request) => request.workflowChars > 0),
      "每次请求的系统提示都带工作流正文",
    );
    const userA = (
      await f.client.call("chat.history", { botId: f.researcher.id, topicId: a.conversationId })
    ).find((row) => row.id === a.userMessageId);
    assert(userA?.content.includes(`运行「${NAME}」`), "可见的运行请求");
    const skillReads = (await f.client.call("audit.list", { botId: f.researcher.id, limit: 200 }))
      .filter((entry) => entry.runId === a.runId && entry.kind === "file.read")
      .filter((entry) => String(entry.detail.path ?? "").endsWith("SKILL.md"));
    assert.equal(skillReads.length, 0, "正文已注入，不再读 SKILL.md");

    // 3. Run B: the draft stays incomplete after both fix rounds → 交付未通过, file kept.
    await rm(join(f.root, brief));
    const startB = f.requests.length;
    const b = await f.client.call("skills.runWorkflow", {
      botId: f.researcher.id,
      skillId: skill.id,
      inputs: { 本期资料: join(f.root, "资料") },
      conversationId: a.conversationId,
    });
    assert(b.status === "started", "运行 B 已启动");
    const runB = await settled(f, b.conversationId, b.assistantMessageId);
    assert.equal(runB.reply.status, "done", "交付未通过也照常显示回复");
    await wait(300);
    const receiptB = await f.client.call("runs.receipt", { runId: b.runId });
    assert(receiptB.delivery, "收据带交付检查");
    assert.equal(receiptB.delivery.status, "failed", "交付未通过");
    assert.equal(receiptB.delivery.fixRounds, 2, "用满两轮修复");
    const sections = receiptB.delivery.items.find((item) => item.id === "a2");
    assert.equal(sections?.status, "fail");
    assert.equal(sections?.reason, "missing_sections");
    assert.deepEqual(sections?.missing, ["来源"], "收据列出缺的小节");
    assert.equal(receiptB.delivery.items.find((item) => item.id === "a3")?.reason, "no_sources");
    assert.equal(receiptB.delivery.items.find((item) => item.id === "a5")?.reason, "too_few_citations");
    assert.equal(receiptB.delivery.items.find((item) => item.id === "a6")?.reason, "section_unsourced");
    assert.equal(receiptB.delivery.items.find((item) => item.id === "a7")?.reason, "missing_columns");
    assert((await stat(join(f.root, brief))).size > 0, "未通过也保留产物");
    const fixPrompts = f.requests.slice(startB).filter((r) => r.route === "researcher").length;

    const text = JSON.stringify([receiptA, receiptB]);
    for (const secret of [
      "WORKFLOW-A",
      "WORKFLOW-B",
      BODY_MARKER,
      "收入增长",
      "synthetic-chat-key-only",
    ])
      assert(!text.includes(secret), `收据不得包含 ${secret}`);

    return {
      scenario: "工作流与交付检查",
      status: "脚本化通过",
      precheck: {
        blocked: [missing.failures[0]?.reason, empty.failures[0]?.reason],
        modelRequests: 0,
      },
      runA: {
        fixRounds: receiptA.delivery.fixRounds,
        status: receiptA.delivery.status,
        checkMs: receiptA.delivery.durationMs,
        modelRequests: requestsA.length,
        approvals: runA.approved,
        workflowBlockChars: requestsA[0]?.workflowChars ?? 0,
      },
      runB: {
        fixRounds: receiptB.delivery.fixRounds,
        status: receiptB.delivery.status,
        missing: sections?.missing,
        checkMs: receiptB.delivery.durationMs,
        modelRequests: fixPrompts,
      },
      nonFixtureNetworkAttempts: f.blocked(),
    };
  } finally {
    await f.cleanup();
  }
}
