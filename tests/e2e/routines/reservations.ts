import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { BotsRepo, transaction } from "../../../packages/storage/src/index.ts";
import { until } from "../chat/harness.ts";
import { approval, draft, type Exercise, terminal } from "./shared.ts";

export async function reservationAcceptance(exercise: Exercise) {
  await exercise("parked聊天抢先、跨话题群任务与恢复", async (f) => {
    await f.dev({ type: "dev-routine-timing", patch: { approvalWaitMs: 300000 } });
    const file = join(f.output, "resume.txt"),
      tool = { name: "write_file", arguments: { path: file, content: "只写一次" } };
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "用户聊天先结束", delayMs: 0 },
    ]);
    const r = await f.rpc.call("routines.create", draft(f));
    const run = await f.rpc.call("routines.runNow", { id: r.id });
    const pending = await approval(f);
    assert.equal(f.service.runs.require(run.runId).status, "waiting");
    const row = (await f.rpc.call("routines.rows", { ids: [r.id] })).rows[0];
    assert.equal(row?.active?.status, "waiting");
    assert.equal(row?.attentionCount, 1);
    // The user writes in the routine's own topic: a new routine no longer becomes the Bot's
    // current topic (acceptance 2026-11-20), so a plain chat.send would go to another topic.
    const chat = await f.rpc.call("chat.send", {
      botId: f.bot.id,
      topicId: r.topicConversationId,
      text: "用户聊天抢先",
    });
    await f.idle(chat.runId);
    const parked = f.service.runs.require(run.runId);
    assert(parked.waitCheckpoint?.drain);
    assert.equal(parked.ownerToken, null);
    // 群成员有独立话题；等待审批的例行只预约原话题，不占用整个 Bot。
    await f.replies([{ text: "群成员独立完成", delayMs: 0 }]);
    await f.replies(
      [
        {
          toolCalls: [
            {
              name: "assign_task",
              arguments: { bot: f.bot.id, title: "独立话题任务", instructions: "合成自动群任务" },
            },
          ],
          delayMs: 0,
        },
        { text: "已派发", delayMs: 0 },
        { text: "已收到成员结果", delayMs: 0 },
      ],
      "writer",
      f.other.id,
    );
    const group = await f.rpc.call("groups.create", {
      name: "预约合成群",
      botIds: [f.bot.id, f.other.id],
      coordinatorBotId: f.other.id,
      autoRoundLimit: 4,
    });
    await f.rpc.call("chat.send", { groupId: group.id, text: "安排合成成员任务" });
    const groupRuns = await until(
      "跨话题自动群任务完成",
      () => f.rpc.call("chat.runs", { groupId: group.id }),
      (rows) =>
        rows.some((item) => item.botId === f.bot.id && item.automatic && item.status === "done"),
    );
    const groupRun = groupRuns.find((item) => item.botId === f.bot.id && item.automatic);
    assert(groupRun);
    assert.notEqual(groupRun.conversationId, parked.conversationId);
    assert.equal(f.service.runs.reservation(f.bot.id, groupRun.conversationId), undefined);
    await until(
      "群运行及完成唤醒排空",
      () => f.rpc.call("chat.runs", { groupId: group.id }),
      (rows) =>
        rows.some(
          (item) => item.botId === f.other.id && item.kind === "wake" && item.status === "done",
        ) && rows.every((item) => !["queued", "running"].includes(item.status)),
    );
    assert.equal(f.service.runs.require(run.runId).status, "waiting");
    // 回复按模型路由共享；所有群续跑结束后才可以安装例行恢复脚本。
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "恢复完成", delayMs: 0 },
    ]);
    await f.rpc.call("approvals.resolve", { id: pending.id, decision: "allow", remember: false });
    const done = await terminal(f, run.runId);
    assert.equal(done.status, "done");
    assert.equal(done.attempt, 2);
    assert.equal(done.runId, parked.runId);
    assert.equal(done.sessionFile, parked.sessionFile);
    assert(done.decisionConsumedAt);
    assert.equal(await readFile(file, "utf8"), "只写一次");
    await assert.rejects(
      f.rpc.call("approvals.resolve", { id: pending.id, decision: "allow", remember: false }),
    );
  });
  await exercise("同话题自动运行等待例行预约释放", async (f) => {
    await f.dev({ type: "dev-routine-timing", patch: { approvalWaitMs: 300000 } });
    const file = join(f.output, "same-topic.txt"),
      tool = { name: "write_file", arguments: { path: file, content: "预约释放" } };
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "用户聊天排空", delayMs: 0 },
    ]);
    const r = await f.rpc.call("routines.create", draft(f));
    const run = await f.rpc.call("routines.runNow", { id: r.id });
    const pending = await approval(f);
    const user = await f.rpc.call("chat.send", {
      botId: f.bot.id,
      topicId: r.topicConversationId,
      text: "先释放SDK执行槽",
    });
    await f.idle(user.runId);
    const parked = await until(
      "原话题SDK排空",
      async () => f.service.runs.require(run.runId),
      (item) => item.status === "waiting" && !!item.waitCheckpoint?.drain,
    );
    assert(parked.conversationId);
    const bot = new BotsRepo(f.db).get(f.bot.id);
    assert(bot);
    // assign_task 总会创建独立话题；这里通过真实队列发布同话题自动项来验证预约边界。
    const queue = f.service.deps.runQueue;
    const input = {
      bot,
      conversationId: parked.conversationId,
      text: "同话题合成自动任务",
      automatic: true,
    };
    const automatic = transaction(f.db, () => queue.insert(input));
    const requests = f.counts().default;
    queue.publish(automatic, input);
    // A negative observation needs an interval. Do not abort that interval after one second:
    // event-loop starvation would produce an AbortError before the reservation is checked.
    await wait(200);
    assert.equal(queue.repo.get(automatic.id)?.status, "queued");
    assert.equal(f.service.runs.require(run.runId).status, "waiting");
    assert.equal(f.service.runs.reservation(bot.id, parked.conversationId)?.id, parked.id);
    assert.equal(f.counts().default, requests, "预约阻塞期间不能消费模型回复");
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "原例行恢复完成", delayMs: 0 },
      { text: "同话题自动项随后完成", delayMs: 0 },
    ]);
    await f.rpc.call("approvals.resolve", { id: pending.id, decision: "allow", remember: false });
    assert.equal((await terminal(f, run.runId)).status, "done");
    await f.idle(automatic.id);
    assert.equal(queue.repo.get(automatic.id)?.status, "done");
    assert.equal(await readFile(file, "utf8"), "预约释放");
  });
}
