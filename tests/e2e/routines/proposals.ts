import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "../chat/harness.ts";
import { approval, draft, type Exercise } from "./shared.ts";

export async function proposalAcceptance(exercise: Exercise) {
  await exercise("提案确认、缺项、修改与窄scope", async (f) => {
    const scope = {
      category: "write_file" as const,
      scope: { kind: "workplace" as const, root: f.output },
    };
    await f.replies([
      {
        toolCalls: [
          {
            name: "routine_propose",
            arguments: {
              name: "窄写任务",
              instructions: "合成写入",
              triggers: [{ kind: "cron", expr: "30 8 * * *", timezone: "Asia/Shanghai" }],
              preauth: [scope],
            },
          },
        ],
        delayMs: 0,
      },
      { text: "等待用户卡确认", delayMs: 0 },
      { text: "已确认", delayMs: 0 },
    ]);
    const chat = await f.rpc.call("chat.send", { botId: f.bot.id, text: "每天写到output" });
    await f.idle(chat.runId);
    const [p] = await f.rpc.call("routines.proposals", { botId: f.bot.id });
    assert(p);
    assert.equal((await f.rpc.call("routines.list", {})).length, 0);
    assert.equal(p.payload.blockedPreauth.length, 0, "主内子目录不能错误禁勾");
    const accepted = await f.rpc.call("routines.proposal.resolve", {
      proposalId: p.id,
      accept: true,
    });
    assert(accepted.routine);
    assert.equal(accepted.routine.preauth[0]?.operation.scope.kind, "workplace");
    const replay = await f.rpc.call("routines.proposal.resolve", {
      proposalId: p.id,
      accept: true,
    });
    assert.equal(replay.routine?.id, accepted.routine.id);
    await until(
      "确认普通SDK回复",
      () => f.rpc.call("chat.runs", { botId: f.bot.id }),
      (rows) => rows.every((r) => !["queued", "running"].includes(r.status)),
    );
    await f.replies([
      {
        toolCalls: [
          { name: "routine_propose", arguments: { routineId: accepted.routine.id, name: "改名" } },
        ],
        delayMs: 0,
      },
      { text: "请确认修改", delayMs: 0 },
      { text: "修改确认", delayMs: 0 },
    ]);
    const update = await f.rpc.call("chat.send", { botId: f.bot.id, text: "修改已有任务" });
    await f.idle(update.runId);
    const modify = (await f.rpc.call("routines.proposals", {})).find(
      (row) => row.payload.routineId,
    );
    assert(modify);
    const updated = await f.rpc.call("routines.proposal.resolve", {
      proposalId: modify.id,
      accept: true,
    });
    assert.equal(updated.routine?.id, accepted.routine.id);
    assert.equal(updated.routine?.name, "改名");
    const manual = await f.rpc.call(
      "routines.create",
      draft(f, { name: "人工窄写", preauth: [scope] }),
    );
    assert.equal(manual.preauth.length, 1);
    // Accepting a proposal only queues its confirmation chat; it must drain before the shared
    // reply route is replaced, or it takes the next step's scripted replies.
    await until(
      "修改确认回复排空",
      () => f.rpc.call("chat.runs", { botId: f.bot.id }),
      (rows) => rows.every((r) => !["queued", "running"].includes(r.status)),
    );
    await f.replies([
      {
        toolCalls: [
          { name: "routine_propose", arguments: { name: "缺项", missingFields: ["发到哪"] } },
        ],
        delayMs: 0,
      },
      { text: "等填写", delayMs: 0 },
      { text: "填好", delayMs: 0 },
    ]);
    const missing = await f.rpc.call("chat.send", { botId: f.bot.id, text: "提案缺项" });
    await f.idle(missing.runId);
    const incomplete = (await f.rpc.call("routines.proposals", {})).find(
      (row) => row.payload.draft.name === "缺项",
    );
    assert(incomplete);
    await assert.rejects(
      f.rpc.call("routines.proposal.resolve", { proposalId: incomplete.id, accept: true }),
    );
    const complete = await f.rpc.call("routines.proposal.resolve", {
      proposalId: incomplete.id,
      accept: true,
      edits: draft(f),
      answers: { 发到哪: "本地主目录" },
    });
    assert(complete.routine);
    // A monitor inside the primary becomes readonly; its descendants must remain blocked.
    await f.rpc.call(
      "routines.create",
      draft(f, { name: "只读监视", triggers: [{ kind: "folder", path: f.monitor }] }),
    );
    const ro = join(f.monitor, "nested");
    await mkdir(ro);
    // A watched folder is read-only for the routine that watches it (not Bot-wide).
    await assert.rejects(
      f.rpc.call(
        "routines.create",
        draft(f, {
          triggers: [{ kind: "folder", path: f.monitor }],
          preauth: [{ category: "write_file", scope: { kind: "workplace", root: ro } }],
        }),
      ),
    );
    assert.equal(
      (await f.rpc.call("workplaces.list", { botId: f.bot.id })).currentId,
      (await f.rpc.call("workplaces.list", { botId: f.bot.id })).folders.find(
        (r) => r.path === f.primary,
      )?.id,
    );
    await until(
      "确认回复排空",
      () => f.rpc.call("chat.runs", { botId: f.bot.id }),
      (rows) => rows.every((run) => !["queued", "running"].includes(run.status)),
    );
    const file = join(f.output, "transfer-must-not-write.txt");
    await f.replies([
      {
        toolCalls: [{ name: "write_file", arguments: { path: file, content: "不能继续旧归属" } }],
        delayMs: 0,
      },
      { text: "已停止", delayMs: 0 },
    ]);
    const question = await f.rpc.call("chat.send", {
      botId: f.bot.id,
      topicId: accepted.routine.topicConversationId,
      text: "原话题普通追问",
    });
    assert.equal((await approval(f)).source, "chat");
    const current = await f.rpc.call("routines.get", { id: accepted.routine.id });
    const transferred = await f.rpc.call("routines.update", {
      id: current.id,
      expectedVersion: current.version,
      patch: { botId: f.other.id },
    });
    assert.equal(transferred.botId, f.other.id);
    assert.equal(
      (await f.idle(question.runId)).find((run) => run.id === question.runId)?.status,
      "aborted",
    );
    assert.equal(
      f.db.prepare("SELECT bot_id bot FROM messages WHERE id=?").get(question.assistantMessageId)
        ?.bot,
      f.bot.id,
    );
    assert.equal(
      f.db
        .prepare("SELECT bot_id bot FROM conversations WHERE id=?")
        .get(transferred.topicConversationId)?.bot,
      f.other.id,
    );
    await assert.rejects(readFile(file));
    const homeBot = await f.rpc.call("bots.create", { description: "无外部主目录的合成Bot" });
    const homeTask = await f.rpc.call(
      "routines.create",
      draft(f, { botId: homeBot.id, triggers: [{ kind: "folder", path: f.monitor }] }),
    );
    assert(homeTask);
    const homePlaces = await f.rpc.call("workplaces.list", { botId: homeBot.id });
    assert.equal(homePlaces.currentId, "home");
    assert.equal(homePlaces.folders.length, 1);
    assert.equal(homePlaces.folders[0]?.path, f.monitor);
  });
}
