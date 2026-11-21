import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { readSessionOperation } from "../../../packages/agent/src/index.ts";
import { until } from "../chat/harness.ts";
import { exerciseOwnerRestart } from "./owner.ts";
import { approval, draft, type Exercise, terminal } from "./shared.ts";

export async function lifecycleAcceptance(exercise: Exercise) {
  await exercise("审批原gate拒绝、expiry、危险ask与sudo拒绝", async (f) => {
    const file = join(f.output, "held.txt");
    const tool = { name: "write_file", arguments: { path: file, content: "不能写" } };
    await f.dev({ type: "dev-routine-timing", patch: { approvalWaitMs: 86400000 } });
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "24小时批准卡拒绝", delayMs: 0 },
    ]);
    const dayTask = await f.rpc.call("routines.create", draft(f)),
      dayRun = await f.rpc.call("routines.runNow", { id: dayTask.id }),
      dayCard = await approval(f);
    // The routine computes expiresAt from its own clock read; the store stamps createdAt with a
    // second read, so the two can straddle a millisecond. The window is 24 h, not 24 h to the ms.
    const dayWindow = Date.parse(dayCard.expiresAt) - Date.parse(dayCard.createdAt);
    assert(Math.abs(dayWindow - 86400000) <= 50, `approval window ${dayWindow} ms`);
    await f.rpc.call("approvals.resolve", { id: dayCard.id, decision: "deny", remember: false });
    await terminal(f, dayRun.runId);
    for (const outcome of ["deny", "expired"] as const) {
      await f.dev({
        type: "dev-routine-timing",
        patch: { approvalWaitMs: outcome === "expired" ? 1000 : 10000 },
      });
      await f.replies([
        { toolCalls: [tool], delayMs: 0 },
        { text: "用户未允许，换办法", delayMs: 0 },
      ]);
      const r = await f.rpc.call("routines.create", draft(f));
      const run = await f.rpc.call("routines.runNow", { id: r.id }),
        card = await approval(f);
      assert.equal(f.service.runs.require(run.runId).attempt, 1);
      if (outcome === "deny")
        await f.rpc.call("approvals.resolve", { id: card.id, decision: "deny", remember: false });
      const done = await terminal(f, run.runId);
      assert.equal(done.status, "done");
      assert.equal(done.attempt, 1);
      assert.equal(f.service.runs.reservation(f.bot.id), undefined);
      await assert.rejects(readFile(file));
      assert.equal(
        f.db.prepare("SELECT status FROM approvals WHERE id=?").get(card.id)?.status,
        outcome === "deny" ? "denied" : "expired",
      );
    }
    // The approval must outlive the wait below, which must outlast the remaining active budget.
    await f.dev({ type: "dev-routine-timing", patch: { approvalWaitMs: 30000 } });
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "等待不计活动预算", delayMs: 0 },
    ]);
    const limited = await f.rpc.call("routines.create", draft(f, { maxDurationMin: 5 }));
    const seeded = f.service.runs.enqueue({
      routineId: limited.id,
      botId: f.bot.id,
      triggerId: null,
      reason: "manual",
      scheduledFor: new Date().toISOString(),
      dedupeKey: "active-budget",
    });
    // This own fixture represents a run that already spent most of its active budget, without changing clocks.
    // 10 s are left: waiting 11 s proves waiting is not counted, and the resumed turn still has
    // room on a loaded machine (2 s left timed out under load: actual "timeout", expected "done").
    f.db.prepare("UPDATE routine_runs SET active_ms=? WHERE id=?").run(290000, seeded.id);
    await f.service.publish(f.service.runs.require(seeded.id), limited);
    const budgetCard = await approval(f);
    await wait(11000);
    assert.equal(f.service.runs.require(seeded.id).status, "waiting");
    await f.rpc.call("approvals.resolve", {
      id: budgetCard.id,
      decision: "allow",
      remember: false,
      preauthorize: true,
    });
    assert.equal((await terminal(f, seeded.id)).status, "done");
    assert.equal(f.service.require(limited.id).preauth.length, 1);
    assert.equal((await f.rpc.call("grants.list", { botId: f.bot.id })).length, 0);
    await f.replies([{ text: "活动预算耗尽", delayMs: 300 }]);
    const timeout = f.service.runs.enqueue({
      routineId: limited.id,
      botId: f.bot.id,
      triggerId: null,
      reason: "manual",
      scheduledFor: new Date().toISOString(),
      dedupeKey: "actual-timeout",
    });
    f.db.prepare("UPDATE routine_runs SET active_ms=? WHERE id=?").run(299800, timeout.id);
    await f.service.publish(f.service.runs.require(timeout.id), limited);
    assert.equal((await terminal(f, timeout.id)).status, "timeout");
    const safe = join(f.primary, "synthetic-danger");
    await writeFile(safe, "never execute");
    await f.service.deps.local.target.isolationStatus(AbortSignal.timeout(10000));
    await f.replies([
      {
        toolCalls: [{ name: "run_command", arguments: { command: `rm -rf ${f.primary}` } }],
        delayMs: 0,
      },
      { text: "危险操作拒绝", delayMs: 0 },
    ]);
    const danger = await f.rpc.call("routines.create", draft(f));
    const dangerRun = await f.rpc.call("routines.runNow", { id: danger.id });
    const dangerCard = await approval(f);
    assert.equal(dangerCard.risk, "danger");
    assert(!dangerCard.canPreauthorize);
    await f.rpc.call("approvals.resolve", { id: dangerCard.id, decision: "deny", remember: false });
    await terminal(f, dangerRun.runId);
    assert.equal(await readFile(safe, "utf8"), "never execute");
    await f.replies([
      {
        toolCalls: [{ name: "run_command", arguments: { command: "sudo echo forbidden" } }],
        delayMs: 0,
      },
      { text: "sudo被拒", delayMs: 0 },
    ]);
    const sudo = await f.rpc.call("routines.runNow", { id: danger.id });
    await terminal(f, sudo.runId);
    assert(
      (await f.rpc.call("audit.list", { limit: 200 })).some(
        (entry) =>
          entry.runId === f.service.runs.require(sudo.runId).runId &&
          entry.kind === "policy.denied" &&
          entry.detail.reasonCode === "privilege_escalation_denied",
      ),
      "提权直接拒绝，不创建审批卡",
    );
    assert.equal((await f.rpc.call("approvals.pending", {})).length, 0);
    assert.equal(
      Number(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE kind='exec.started'").get()?.n),
      0,
    );
  });
  await exercise("parked变更策略allow/deny/expiry安全失败及取消竞态", async (f) => {
    for (const outcome of ["allow", "deny", "expired", "cancel"] as const) {
      await f.rpc.call("bots.update", { botId: f.bot.id, permissionOverrides: {} });
      await f.dev({
        type: "dev-routine-timing",
        patch: { approvalWaitMs: 10000 },
      });
      const file = join(f.output, `${outcome}.txt`),
        tool = { name: "write_file", arguments: { path: file, content: "不能复活" } };
      await f.replies([
        { toolCalls: [tool], delayMs: 0 },
        { text: "用户聊天", delayMs: 0 },
        { toolCalls: [tool], delayMs: 0 },
        { text: "结果", delayMs: 0 },
      ]);
      const r = await f.rpc.call("routines.create", draft(f)),
        run = await f.rpc.call("routines.runNow", { id: r.id });
      const card = await approval(f);
      // In the routine's own topic: a new routine is not the Bot's current topic (2026-11-20).
      const user = await f.rpc.call("chat.send", {
        botId: f.bot.id,
        topicId: r.topicConversationId,
        text: "用户到场",
      });
      await f.idle(user.runId);
      assert(f.service.runs.require(run.runId).waitCheckpoint?.drain);
      if (outcome === "cancel") {
        const appId = f.service.runs.require(run.runId).runId;
        assert(appId);
        const abort = f.rpc.call("chat.abort", { runId: appId });
        const allow = f.rpc.call("approvals.resolve", {
          id: card.id,
          decision: "allow",
          remember: false,
        });
        await Promise.allSettled([abort, allow]);
        assert.equal((await terminal(f, run.runId)).status, "cancelled");
      } else {
        await f.rpc.call("bots.update", { botId: f.bot.id, permissionOverrides: { web: "never" } });
        if (outcome === "expired") {
          // Expiry must follow the policy mutation, not race the HTTP/model/park setup.
          // Otherwise a valid expiry can resume and finish before there is anything to invalidate.
          assert.equal(
            f.db.prepare("SELECT status FROM approvals WHERE id=?").get(card.id)?.status,
            "pending",
          );
          f.db
            .prepare("UPDATE approvals SET expires_at=? WHERE id=? AND status='pending'")
            .run(new Date(0).toISOString(), card.id);
          await f.service.execution.pollWaiting(AbortSignal.timeout(10000));
        } else
          await assert.rejects(
            f.rpc.call("approvals.resolve", { id: card.id, decision: outcome, remember: false }),
          );
        const failed = await terminal(f, run.runId);
        assert.equal(failed.status, "failed", `parked policy change: ${outcome}`);
        assert.equal(failed.errorCode, "routine_resume_invalid");
      }
      await assert.rejects(readFile(file));
      assert.equal(f.service.runs.reservation(f.bot.id), undefined);
      assert.equal(
        (await f.rpc.call("chat.runs", { botId: f.bot.id })).find((r) => r.id === user.runId)
          ?.status,
        "done",
      );
    }
  });
  await exercise("overlap、30分钟缩时排队、停放stop及FIFO读取", async (f) => {
    await f.dev({ type: "dev-routine-timing", patch: { queueWaitMs: 1000 } });
    const tool = {
      name: "write_file",
      arguments: { path: join(f.output, "queue.txt"), content: "不执行" },
    };
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "用户优先", delayMs: 0 },
    ]);
    const r = await f.rpc.call("routines.create", draft(f)),
      run = await f.rpc.call("routines.runNow", { id: r.id });
    const card = await approval(f);
    const overlap = await f.rpc.call("routines.runNow", { id: r.id });
    assert.equal(f.service.runs.require(overlap.runId).status, "skipped_overlap");
    const other = await f.rpc.call("routines.create", draft(f, { name: "被预约阻塞" }));
    // The newest topic, as before 2026-11-20 when a new routine became the current topic.
    const user = await f.rpc.call("chat.send", {
      botId: f.bot.id,
      topicId: other.topicConversationId,
      text: "普通聊天",
    });
    await f.idle(user.runId);
    const queued = await f.rpc.call("routines.runNow", { id: other.id });
    assert.equal((await terminal(f, queued.runId)).errorCode, "queue_timeout");
    assert.equal(f.service.runs.require(run.runId).status, "waiting");
    const row = (await f.rpc.call("routines.rows", { ids: [r.id] })).rows[0];
    assert.equal(row?.active?.id, run.runId);
    assert.equal(row?.active?.status, "waiting");
    const actualAppId = f.service.runs.require(run.runId).runId;
    assert(actualAppId);
    const events: string[] = [];
    const unsubscribe = f.rpc.on("routine.run", (event) => {
      if (event.routineRunId === run.runId) events.push(event.status);
    });
    try {
      await f.rpc.call("chat.abort", { runId: actualAppId });
      await until(
        "真实取消终态事件",
        async () => events,
        (values) => values.includes("cancelled"),
      );
    } finally {
      unsubscribe();
    }
    assert.equal((await terminal(f, run.runId)).status, "cancelled");
    await assert.rejects(
      f.rpc.call("approvals.resolve", { id: card.id, decision: "allow", remember: false }),
    );
    const directory = join(f.root, "fifo-session");
    await mkdir(directory);
    const file = join(directory, "session.jsonl");
    await writeFile(
      file,
      JSON.stringify({ type: "session", version: 3, id: "synthetic", cwd: f.primary }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "a",
          parentId: null,
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call", name: "read_file", arguments: { path: file } },
            ],
          },
        }) +
        "\n",
    );
    assert.equal(
      (
        await readSessionOperation({
          sessionDir: directory,
          sessionFile: file,
          toolCallId: "call",
          signal: AbortSignal.timeout(1000),
        })
      ).tool,
      "read_file",
    );
    if (process.platform !== "win32") {
      const fifo = join(directory, "fifo.jsonl");
      // Fixture setup only; this is not a model command or an execution authority port.
      await promisify(execFile)("mkfifo", [fifo], { signal: AbortSignal.timeout(1000) });
      const start = performance.now();
      await assert.rejects(
        readSessionOperation({
          sessionDir: directory,
          sessionFile: fifo,
          toolCallId: "call",
          signal: AbortSignal.timeout(1000),
        }),
      );
      assert(performance.now() - start < 1000);
    }
    await assert.rejects(
      readSessionOperation({
        sessionDir: directory,
        sessionFile: file,
        toolCallId: "call",
        signal: AbortSignal.abort("fixture cancelled"),
      }),
    );
    await exerciseOwnerRestart(f);
  });
}
