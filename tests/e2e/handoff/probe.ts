import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import type { GroupTask } from "../../../packages/protocol/src/index.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { type Fixture, fixture, until } from "../chat/harness.ts";

const ROUND_LIMIT = 2;

function assign(bot: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    toolCalls: [
      {
        name: "assign_task",
        arguments: { bot, title, instructions: `${title}：按要求完成。`, ...extra },
      },
    ],
  };
}
function write(path: string, content: string) {
  return { toolCalls: [{ name: "write_file", arguments: { path, content } }] };
}

/** Polls until `ready`, answering every approval card with "allow once" meanwhile. */
async function settle<T>(
  f: Fixture,
  label: string,
  read: () => Promise<T>,
  ready: (v: T) => boolean,
) {
  return until(
    label,
    async () => {
      for (const approval of await f.client.call("approvals.pending", {}))
        await f.client.call("approvals.resolve", {
          id: approval.id,
          decision: "allow",
          remember: false,
        });
      return read();
    },
    ready,
  );
}

async function idle(f: Fixture) {
  // Hand-off checks run between a member's completion and the coordinator's wake; give them a
  // moment so "idle" is not read in that gap.
  for (let quiet = 0; quiet < 3; ) {
    const runs = await settle(
      f,
      "群运行终态",
      () => f.client.call("chat.runs", { groupId: f.group.id }),
      (rows) => rows.length > 0 && rows.every((r) => !["running", "queued"].includes(r.status)),
    );
    await wait(300);
    const again = await f.client.call("chat.runs", { groupId: f.group.id });
    quiet =
      again.length === runs.length && again.every((r) => r.status !== "running") ? quiet + 1 : 0;
  }
  return f.client.call("chat.runs", { groupId: f.group.id });
}

const tasksOf = (f: Fixture) => f.client.call("groups.tasks", { groupId: f.group.id });
const coordinatorTasks = (tasks: GroupTask[]) =>
  tasks.filter((task) => task.source?.kind === "coordinator");

/** 1. Three stages, each with an expected file, under a round limit of 2. */
async function pipeline(root: string) {
  const scenario: Scenario = {
    replies: [{ text: "未匹配到演练身份。" }],
    routes: {
      coordinator: [
        assign("研究员", "数据", {
          expectedOutput: { files: ["out/data.md"], form: "给写手用的表格" },
          doneWhen: { condition: "口径写清楚" },
        }),
        { text: "已分派数据。" },
        assign("写手", "初稿", { expectedOutput: { files: ["out/draft.md"] } }),
        { text: "已分派初稿。" },
        assign("研究员", "复核", { expectedOutput: { files: ["out/review.md"] } }),
        { text: "已分派复核。" },
        { text: "PIPELINE-DONE 三段完成。" },
      ],
      researcher: [
        write("out/data.md", "# 数据\n口径：月度\n"),
        { text: "数据已交。" },
        write("out/review.md", "# 复核\n无问题\n"),
        { text: "复核已交。" },
      ],
      writer: [write("out/draft.md", "# 初稿\n结论在前\n"), { text: "初稿已交。" }],
    },
  };
  const f = await fixture(scenario, root);
  try {
    await f.client.call("groups.update", { groupId: f.group.id, autoRoundLimit: ROUND_LIMIT });
    const started = performance.now();
    await f.client.call("chat.send", { groupId: f.group.id, text: "跑三段流水线" });
    const tasks = await settle(
      f,
      "三段交接完成",
      () => tasksOf(f),
      (rows) =>
        coordinatorTasks(rows).length === 3 &&
        coordinatorTasks(rows).every((t) => t.status === "done" && t.handoff?.state === "met"),
    );
    await idle(f);
    const elapsedMs = Math.round(performance.now() - started);
    const state = await f.client.call("groups.state", { groupId: f.group.id });
    assert.equal(state.limited, false, "交接不触发自动轮次上限");
    assert.equal(state.rounds, 0, "交接不计入自动轮次");
    assert.equal(state.handoffs, 6, "3 次分派 + 3 次签收唤醒");
    const history = await f.client.call("chat.history", { groupId: f.group.id, limit: 200 });
    assert(
      history.some((m) => m.content.includes("PIPELINE-DONE")),
      "统筹收到第三段并收尾",
    );
    assert(!history.some((m) => m.content.includes("停下来等你")), "没有停下来等你");
    const data = coordinatorTasks(tasks).find((t) => t.title === "数据");
    assert.deepEqual(data?.handoff?.files, ["out/data.md"]);
    assert.equal(data?.handoff?.form, "给写手用的表格");
    assert.equal(data?.handoff?.condition, "口径写清楚");
    assert.deepEqual(
      data?.handoff?.items.map((i) => [i.deliverable, i.status]),
      [["out/data.md", "pass"]],
    );
    assert(
      data?.handoff?.artifacts.some((p) => p.endsWith("data.md")),
      "产物路径来自改动记录",
    );
    return {
      stages: 3,
      roundLimit: ROUND_LIMIT,
      rounds: state.rounds,
      handoffs: state.handoffs,
      coordinatorRequests: f.counts().coordinator,
      elapsedMs,
    };
  } finally {
    await f.cleanup();
  }
}

/** 2. The expected file never appears: one send-back, then the group stops for the user. */
async function sendBackThenStop(root: string) {
  const scenario: Scenario = {
    replies: [{ text: "未匹配到演练身份。" }],
    routes: {
      coordinator: [
        assign("研究员", "数据", { expectedOutput: { files: ["out/data.md"] } }),
        { text: "已分派数据。" },
        { text: "UNEXPECTED-WAKE" },
      ],
      researcher: [{ text: "做完了（其实没写文件）。" }, { text: "补过了（还是没写）。" }],
    },
  };
  const f = await fixture(scenario, root);
  try {
    await f.client.call("groups.update", { groupId: f.group.id, autoRoundLimit: ROUND_LIMIT });
    await f.client.call("chat.send", { groupId: f.group.id, text: "整理数据" });
    const tasks = await settle(
      f,
      "退回一次后停下",
      () => tasksOf(f),
      (rows) => coordinatorTasks(rows).some((t) => t.handoff?.state === "unmet"),
    );
    await idle(f);
    const handoffs = coordinatorTasks(tasks);
    assert.equal(handoffs.length, 2, "原任务 + 一次退回");
    const original = handoffs.find((t) => !t.handoff?.returnOf);
    const returned = handoffs.find((t) => t.handoff?.returnOf);
    assert.equal(original?.handoff?.state, "returned");
    assert.equal(returned?.handoff?.returnOf, original?.id);
    assert.equal(returned?.handoff?.state, "unmet");
    assert.equal(returned?.handoff?.items[0]?.reason, "missing_file");
    const state = await f.client.call("groups.state", { groupId: f.group.id });
    assert.equal(state.limited, true, "停下来等用户");
    assert.equal(state.rounds, 0);
    assert.equal(state.handoffs, 2, "分派 + 退回");
    const history = await f.client.call("chat.history", { groupId: f.group.id, limit: 200 });
    assert(
      history.some((m) => m.content.includes("退回后仍未满足")),
      "群里说明缺什么",
    );
    assert(!history.some((m) => m.content.includes("UNEXPECTED-WAKE")), "不再唤醒统筹");
    assert.equal(f.counts().researcher, 2, "成员只多跑一次");
    const audits = await f.client.call("audit.list", { limit: 200 });
    assert(
      audits.some(
        (a) => a.kind === "collaboration.queued" && a.detail.collaborationAction === "return",
      ),
      "退回写审计",
    );
    return {
      sendBacks: 1,
      memberRuns: f.counts().researcher,
      coordinatorRequests: f.counts().coordinator,
      checkItems: returned?.handoff?.items.length,
      handoffs: state.handoffs,
    };
  } finally {
    await f.cleanup();
  }
}

/** 3. Plain assignments are free discussion: the round limit still stops them. */
async function freeDiscussion(root: string) {
  const scenario: Scenario = {
    replies: [{ text: "未匹配到演练身份。" }],
    routes: {
      coordinator: [
        {
          toolCalls: [...assign("研究员", "研究").toolCalls, ...assign("写手", "写作").toolCalls],
        },
        { text: "已分派。" },
        { text: "UNEXPECTED-FREE-WAKE" },
      ],
      researcher: [{ text: "研究完成。" }],
      writer: [{ text: "写作完成。" }],
    },
  };
  const f = await fixture(scenario, root);
  try {
    await f.client.call("groups.update", { groupId: f.group.id, autoRoundLimit: ROUND_LIMIT });
    await f.client.call("chat.send", { groupId: f.group.id, text: "研究和写作" });
    await settle(
      f,
      "自由讨论到上限",
      () => f.client.call("groups.state", { groupId: f.group.id }),
      (state) => state.limited,
    );
    await idle(f);
    const state = await f.client.call("groups.state", { groupId: f.group.id });
    assert.equal(state.rounds, ROUND_LIMIT, "普通分派计入自动轮次");
    assert.equal(state.handoffs ?? 0, 0);
    const tasks = coordinatorTasks(await tasksOf(f));
    assert(
      tasks.every((t) => !t.handoff),
      "普通分派不是交接",
    );
    const history = await f.client.call("chat.history", { groupId: f.group.id, limit: 200 });
    assert(!history.some((m) => m.content.includes("UNEXPECTED-FREE-WAKE")), "到上限不再唤醒");
    assert(
      history.some((m) => m.content.includes("自动来回")),
      "停下来等你",
    );
    return { rounds: state.rounds, limited: state.limited };
  } finally {
    await f.cleanup();
  }
}

export async function runHandoffProbe(root: string) {
  return {
    scenario: "群编排结构化",
    status: "脚本化通过",
    pipeline: await pipeline(root),
    sendBack: await sendBackThenStop(root),
    freeDiscussion: await freeDiscussion(root),
  };
}
