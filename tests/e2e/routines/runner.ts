import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { RoutineDevStateRepo } from "../../../packages/routines/src/store/index.ts";
import { until } from "../chat/harness.ts";
import type { AcceptanceResult } from "../supervisor.ts";
import { connectionUpgradeAcceptance } from "./connection-upgrade.ts";
import { type M3Fixture, m3Fixture } from "./fixture.ts";
import { ledgerAcceptance } from "./ledger.ts";
import { lifecycleAcceptance } from "./lifecycle.ts";
import { pauseFolderAcceptance } from "./pause-files.ts";
import { proposalAcceptance } from "./proposals.ts";
import { reservationAcceptance } from "./reservations.ts";
import { schedulerAcceptance } from "./scheduler.ts";
import { approval, draft, terminal, watermark } from "./shared.ts";

export async function runM3Acceptance(
  root: string,
  phase?: "pause-folders" | "scheduler" | "ledger",
) {
  const results: AcceptanceResult[] = [];
  const exercise = async (name: string, action: (f: M3Fixture) => Promise<void>) => {
    if (process.env.PIBOT_M3_CASE && process.env.PIBOT_M3_CASE !== name) return;
    let f: M3Fixture | undefined;
    let step = "fixture";
    let failure: Error | undefined;
    try {
      f = await m3Fixture(root);
      step = "assertions";
      await action(f);
      assert.equal(f.blocked(), 0);
    } catch (error) {
      failure = error instanceof Error ? error : new Error("routine_non_error_failure");
      failure.message = `[${name}] step=${step} ${failure.message}`;
    }
    if (f) {
      try {
        await f.cleanup();
      } catch (error) {
        // Cleanup must neither hide the original assertion nor lose a second failure.
        if (failure) failure.message += " cleanup=routine_cleanup_failed";
        else {
          failure = error instanceof Error ? error : new Error("routine_non_error_failure");
          failure.message = `[${name}] step=cleanup code=routine_cleanup_failed ${failure.message}`;
        }
      }
    }
    if (failure) throw failure;
    assert(f);
    assert.equal(f.blocked(), 0);
    results.push({
      scenario: name,
      status: "脚本化通过",
      requests: f.counts(),
      nonFixtureNetworkAttempts: f.blocked(),
      window: "未验证",
    });
  };
  if (phase === "pause-folders") {
    await exercise("暂停到期folder事实、三策略、混合及取消", pauseFolderAcceptance);
    return results;
  }
  if (phase === "scheduler") {
    await schedulerAcceptance(exercise);
    return results;
  }
  // The ledger scenarios get their own phase, so the main phase keeps its 300 s budget.
  if (phase === "ledger") {
    await ledgerAcceptance(exercise);
    return results;
  }
  await connectionUpgradeAcceptance(exercise);
  await proposalAcceptance(exercise);
  await exercise("真实SDK fresh会话、摘要脱敏、话题及通知", async (f) => {
    await f.replies([
      { text: "合成摘要Alpha synthetic-routines-key-only", delayMs: 0 },
      { text: "第二轮结果", delayMs: 0 },
    ]);
    const r = await f.rpc.call("routines.create", draft(f));
    const first = await f.rpc.call("routines.runNow", { id: r.id });
    const a = await terminal(f, first.runId);
    assert.equal(a.status, "done");
    const second = await f.rpc.call("routines.runNow", { id: r.id });
    const b = await terminal(f, second.runId);
    assert.equal(b.status, "done");
    const row = (await f.rpc.call("routines.rows", { ids: [r.id] })).rows[0];
    assert.equal(row?.lastResult?.id, b.id);
    assert.equal(row?.active, null);
    assert(row?.nextAt);
    const sessionA = String(
      f.db.prepare("SELECT session_file file FROM runs WHERE id=?").get(a.runId)?.file,
    );
    const sessionB = String(
      f.db.prepare("SELECT session_file file FROM runs WHERE id=?").get(b.runId)?.file,
    );
    assert.notEqual(sessionA, sessionB);
    assert((await readFile(join(f.root, "data", sessionA), "utf8")).includes('"version":3'));
    const input = JSON.stringify(f.requests.at(-1)?.body.messages);
    assert(input.includes("合成摘要Alpha"));
    assert(!input.includes("synthetic-routines-key-only"));
    const messages = await f.rpc.call("chat.history", {
      botId: f.bot.id,
      topicId: r.topicConversationId,
    });
    assert.equal(messages.filter((m) => m.routineTrigger).length, 2);
    await until(
      "通知实际目标",
      async () => f.notifications,
      (items) => items.some((n) => n.routineRunId === b.id),
    );
    const notice = f.notifications.find((n) => n.routineRunId === b.id);
    assert(notice);
    assert.equal(notice.conversationId, r.topicConversationId);
    assert.equal(notice.botId, f.bot.id);
    assert((notice.body ?? "").length <= 80);
    const sessions = await readdir(join(f.root, "data", "bots", f.bot.id, "sessions"));
    assert.equal(sessions.filter((s) => s.startsWith("routine-")).length, 2);
  });
  await exercise("预授权真实写、trial隔离与权限收紧", async (f) => {
    const file = join(f.output, "actual.txt");
    const tool = { name: "write_file", arguments: { path: file, content: "真实合成写入" } };
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "写入完成", delayMs: 0 },
    ]);
    const r = await f.rpc.call(
      "routines.create",
      draft(f, {
        preauth: [{ category: "write_file", scope: { kind: "workplace", root: f.output } }],
      }),
    );
    const now = await f.rpc.call("routines.runNow", { id: r.id });
    const nowResult = await terminal(f, now.runId);
    assert.equal(nowResult.status, "done", `run code=${nowResult.errorCode ?? "none"}`);
    assert.equal(await readFile(file, "utf8"), "真实合成写入");
    assert.equal((await f.rpc.call("approvals.pending", {})).length, 0);
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "普通聊天仍询问", delayMs: 0 },
    ]);
    const ordinary = await f.rpc.call("chat.send", { botId: f.bot.id, text: "普通聊天同一写操作" });
    const ordinaryCard = await approval(f);
    assert.equal(ordinaryCard.source, "chat");
    await f.rpc.call("approvals.resolve", {
      id: ordinaryCard.id,
      decision: "deny",
      remember: false,
    });
    await f.idle(ordinary.runId);
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "试运行完成", delayMs: 0 },
    ]);
    const trial = await f.rpc.call(
      "routines.trialRun",
      draft(f, {
        preauth: [{ category: "write_file", scope: { kind: "workplace", root: f.output } }],
      }),
    );
    const pending = await approval(f);
    assert.equal(pending.source, "trial");
    assert(!pending.canPreauthorize);
    await f.rpc.call("approvals.resolve", { id: pending.id, decision: "allow", remember: false });
    const trialResult = await terminal(f, trial.runId);
    assert.equal(trialResult.status, "done", `run code=${trialResult.errorCode ?? "none"}`);
    assert.equal(
      (await f.rpc.call("routines.trialResult", { runId: trial.runId })).allowedOps.length,
      1,
    );
    await f.rpc.call("bots.update", {
      botId: f.bot.id,
      permissionOverrides: { write_file: "never" },
    });
    assert.equal(
      (await f.rpc.call("routines.get", { id: r.id })).preauth[0]?.invalidReason,
      "permission",
    );
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "权限拒绝", delayMs: 0 },
    ]);
    const denied = await f.rpc.call("routines.runNow", { id: r.id });
    await terminal(f, denied.runId);
    assert.equal((await f.rpc.call("approvals.pending", {})).length, 0);
    assert(
      (await f.rpc.call("audit.list", { limit: 200 })).some((e) => e.kind === "policy.denied"),
    );
    await f.rpc.call("bots.update", { botId: f.bot.id, permissionOverrides: {} });
    await rename(f.primary, `${f.primary}-old`);
    await mkdir(f.output, { recursive: true });
    const invalid = await f.rpc.call("routines.get", { id: r.id });
    assert.equal(invalid.preauth[0]?.invalidReason, "workspace");
    const original = invalid.preauth[0];
    assert(original);
    const renamed = await f.rpc.call("routines.update", {
      id: r.id,
      expectedVersion: invalid.version,
      patch: { name: "仅改名" },
    });
    assert.equal(renamed.preauth[0]?.id, original.id);
    assert.deepEqual(renamed.preauth[0]?.workspaceSnapshot, original.workspaceSnapshot);
    const removed = await f.rpc.call("routines.update", {
      id: r.id,
      expectedVersion: renamed.version,
      patch: { preauth: [] },
    });
    const readded = await f.rpc.call("routines.update", {
      id: r.id,
      expectedVersion: removed.version,
      patch: { preauth: [original.operation] },
    });
    assert.notEqual(readded.preauth[0]?.id, original.id);
    assert.equal(
      (await f.rpc.call("routines.get", { id: r.id })).preauth[0]?.invalidReason,
      undefined,
    );
  });
  await reservationAcceptance(exercise);
  await exercise("全局暂停期间不补跑", async (f) => {
    const r = await f.rpc.call(
      "routines.create",
      draft(f, { triggers: [{ kind: "cron", expr: "* * * * *", timezone: "UTC" }] }),
    );
    await f.rpc.call("routines.pauseAll", { until: new Date(Date.now() + 3600000).toISOString() });
    watermark(f, r, new Date(Date.now() - 600000).toISOString());
    await f.rpc.call("routines.resumeAll", undefined);
    assert.equal(f.service.runs.list(r.id).length, 0, "主动暂停期间的周期不能作为睡眠错过补跑");
  });
  await exercise("启动旧活跃超过7天先暂停再接受focus", async (f) => {
    const r = await f.rpc.call("routines.create", draft(f));
    new RoutineDevStateRepo(f.db, { dev: true }).setUiActive(
      new Date(Date.now() - 8 * 86400000).toISOString(),
    );
    await f.stop();
    await f.boot(new Date().toISOString());
    assert.equal((await f.rpc.call("routines.get", { id: r.id })).pausedReason, "away_7d");
    await f.rpc.call("routines.resumeAway", { ids: [r.id] });
    assert.equal((await f.rpc.call("routines.get", { id: r.id })).pausedReason, null);
    assert.equal(f.service.runs.list(r.id).length, 0);
  });
  await lifecycleAcceptance(exercise);
  return results;
}
