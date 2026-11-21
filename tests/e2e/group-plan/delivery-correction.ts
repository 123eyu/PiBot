// A missing member report must be supplied in the same run before its handoff can pass.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GroupPlan } from "../../../packages/protocol/src/index.ts";
import type { Reply, Scenario } from "../../../tools/fake-llm/scenario.ts";
import { type Fixture, fixture, until } from "../chat/harness.ts";

const done = (): Reply => ({ text: "合成步骤完成" });
const write = (): Reply => ({
  toolCalls: [{ name: "write_file", arguments: {
    path: "__REPORT__", content: "# 检查记录\n合成证据\n结论：通过（Verdict: PASS）\n",
  } }],
});

function requestText(body: Record<string, unknown>) {
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(body.messages ?? body.input);
  return strings.join("\n");
}

function read<T>(f: Fixture, query: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(join(f.root, "data", "pibot.db"), { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

async function configure(f: Fixture) {
  const created = await f.client.call("builtin.create", { groups: ["dev-lite"], source: "template" });
  const groupId = created.groupIds[0];
  assert(groupId);
  const group = await f.client.call("groups.get", { groupId });
  const bots = await f.client.call("bots.list", {});
  const provider = bots.find((bot) => bot.id === f.main.id)?.modelProvider;
  assert(provider);
  const member = (role: string) => {
    const bot = bots.find((bot) => group.members.some((m) => m.botId === bot.id) && bot.role?.id === role);
    assert(bot);
    return bot;
  };
  const author = member("fullstack-dev"), verifier = member("qa-engineer");
  for (const [bot, modelId] of [[author, "coordinator"], [verifier, "researcher"]] as const)
    await f.client.call("bots.update", { botId: bot.id, modelProvider: provider, modelId, thinkingLevel: "off" });
  f.pickFolderNext(f.root);
  const bound = await f.client.call("groups.folders.add", { groupId });
  const folder = bound.folders?.find((item) => item.path === f.root);
  assert(folder);
  await f.client.call("groups.folders.setPrimary", { groupId, folderId: folder.id });
  return { groupId, author, verifier };
}

function step(id: string, botId: string, dependsOn: string[], verdict = false): GroupPlan["steps"][number] {
  return {
    id, title: id, owner: { botId }, dependsOn,
    task: "写报告并按合同核对；只补交缺少的报告，不重做浏览器检查。",
    inputs: dependsOn.map((stepId) => ({ stepId, deliverableId: "report" })),
    deliverables: [{ id: "report", kind: "md", path: `${id}.md`, sections: ["检查记录"] }],
    acceptance: verdict ? [
      { id: "exists", check: "exists", deliverable: "report" },
      { id: "sections", check: "sections", deliverable: "report" },
      { id: "verdict", check: "verdict", deliverable: "report" },
    ] : [{ id: "exists", check: "exists", deliverable: "report" }],
    maxFixRounds: verdict ? 1 : 0,
  };
}

function assertSingleRun(f: Fixture, groupId: string) {
  const states = read(f, (db) => db.prepare(
    "SELECT s.attempt,s.execution_run_id,r.task_id,r.message_id FROM group_workflow_steps s JOIN group_workflow_runs w ON w.id=s.workflow_run_id JOIN runs r ON r.id=s.execution_run_id WHERE w.group_id=? AND s.step_id='report'",
  ).all(groupId));
  assert.equal(states.length, 1);
  const state = states[0];
  assert(state);
  const taskId = state.task_id, messageId = state.message_id;
  assert(typeof taskId === "string");
  assert(typeof messageId === "string");
  const runs = read(f, (db) => db.prepare("SELECT COUNT(*) n FROM runs WHERE task_id=?").get(taskId));
  assert.equal(runs?.n, 1, "delivery correction must stay inside the original run");
  assert.equal(state.attempt, 0, "the step must not be sent back");
  const message = read(f, (db) => db.prepare("SELECT usage FROM messages WHERE id=?").get(messageId));
  const usage = JSON.parse(String(message?.usage)) as { delivery: { fixRounds: number; status: string } };
  assert.equal(usage.delivery.fixRounds, 1);
  assert.equal(usage.delivery.status, "passed");
  const handoff = read(f, (db) => db.prepare("SELECT state,result FROM group_task_handoffs WHERE task_id=?").get(taskId));
  assert.equal(handoff?.state, "met");
  const result = JSON.parse(String(handoff?.result)) as { items: { status: string }[] };
  assert(result.items.length >= 3);
  assert(result.items.every((item) => item.status === "pass"));
}

export async function deliveryCorrectionScenario(root: string) {
  let plan: GroupPlan = { name: "运行内补交验收", estimatedCostUsd: 0, steps: [] };
  let corrected = false;
  const scenario: Scenario = { replies: [done()], routes: {
    coordinator: [{ toolCalls: [{ name: "group_plan", arguments: { plan: {} } }] }, done(), write(), done()],
    researcher: [done(), write(), done()],
  } };
  const f = await fixture(scenario, root, {}, {}, { onRequest(body, route, index) {
    const text = requestText(body);
    const last = (pattern: RegExp) => [...text.matchAll(pattern)].at(-1)?.[1];
    for (const call of scenario.routes?.[route]?.[index]?.toolCalls ?? []) {
      if (call.name === "group_plan") call.arguments.plan = plan;
      if (call.name !== "write_file" || call.arguments.path !== "__REPORT__") continue;
      if (route === "researcher") {
        assert.match(text, /交付检查未通过|Delivery check failed/);
        corrected = true;
      }
      const folder = last(/产物目录 \/ Output folder:\n([^\n]+)/g);
      const raw = last(/交付合同 \/ Delivery contract:\n([^\n]+)/g);
      assert(folder && raw);
      const contract = JSON.parse(raw) as { deliverables: { path: string }[] };
      assert(contract.deliverables[0]);
      call.arguments.path = join(folder, contract.deliverables[0].path);
    }
  } });
  try {
    const { groupId, author, verifier } = await configure(f);
    plan.steps = [step("implementation", author.id, []), step("report", verifier.id, ["implementation"], true)];
    await f.client.call("chat.send", { groupId, text: "分工实现并交付独立核对报告。" });
    await until("same-run report correction passed", async () => {
      for (const card of await f.client.call("approvals.pending", {}))
        await f.client.call("approvals.resolve", { id: card.id, decision: "allow", remember: false });
      return read(f, (db) => db.prepare("SELECT status FROM group_workflow_runs WHERE group_id=? ORDER BY rowid").all(groupId));
    }, (rows) => rows.length === 1 && rows[0]?.status === "passed");
    assert(corrected);
    assertSingleRun(f, groupId);
    return { passed: true, sameRun: true };
  } finally {
    await f.cleanup();
  }
}
