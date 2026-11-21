import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import { m3Fixture } from "./fixture.ts";
import { approval, draft, terminal } from "./shared.ts";

export async function runOwner(input: {
  phase: "held" | "parked" | "resume";
  original?: "held" | "parked";
  temporaryRoot: string;
  checkpoint?: { root: string; provider: string; run: string; card: string; session: string };
}, progress: (step: string) => void = () => {}) {
  const f = await m3Fixture(input.temporaryRoot, input.checkpoint);
  // The fixture boot (DB, RPC, worker threads) is the second slow step of a cold owner.
  progress("fixture");
  const file = join(f.output, "restart.txt"),
    tool = { name: "write_file", arguments: { path: file, content: "新owner一次写入" } };
  if (input.phase === "resume") {
    try {
      assert(input.checkpoint);
      const current = f.service.runs.require(input.checkpoint.run);
      if (input.original === "held") {
        assert.equal(current.status, "failed");
        assert.equal(current.errorCode, "interrupted_restart");
        await assert.rejects(
          f.rpc.call("approvals.resolve", {
            id: input.checkpoint.card,
            decision: "allow",
            remember: false,
          }),
        );
        await assert.rejects(readFile(file));
      } else {
        assert.equal(current.status, "waiting");
        assert(current.waitCheckpoint?.drain);
        await f.replies([
          { toolCalls: [tool], delayMs: 0 },
          { text: "真实新owner恢复", delayMs: 0 },
        ]);
        await f.rpc.call("approvals.resolve", {
          id: input.checkpoint.card,
          decision: "allow",
          remember: false,
        });
        const resumed = await terminal(f, current.id);
        assert.equal(resumed.status, "done");
        assert.equal(
          String(
            f.db.prepare("SELECT session_file file FROM runs WHERE id=?").get(resumed.runId)?.file,
          ),
          input.checkpoint.session,
        );
        assert.equal(await readFile(file, "utf8"), "新owner一次写入");
      }
      assert.equal(f.service.runs.reservation(f.bot.id), undefined);
      const attempts = f.service.runs.require(current.id).attempt;
      await f.cleanup();
      parentPort?.postMessage({ status: "ready", attempts, blocked: f.blocked() });
    } catch (error) {
      await f.cleanup();
      throw error;
    }
  } else {
    await f.dev({ type: "dev-routine-timing", patch: { approvalWaitMs: 300000 } });
    await f.replies([
      { toolCalls: [tool], delayMs: 0 },
      { text: "抢先聊天", delayMs: 0 },
    ]);
    const r = await f.rpc.call("routines.create", draft(f)),
      run = await f.rpc.call("routines.runNow", { id: r.id }),
      card = await approval(f);
    if (input.phase === "parked") {
      // In the routine's own topic: a new routine is not the Bot's current topic (2026-11-20).
      const chat = await f.rpc.call("chat.send", {
        botId: f.bot.id,
        topicId: r.topicConversationId,
        text: "真实用户抢先",
      });
      await f.idle(chat.runId);
      assert(f.service.runs.require(run.runId).waitCheckpoint?.drain);
    }
    const session = f.service.runs.require(run.runId).sessionFile;
    assert(session);
    parentPort?.postMessage({
      status: "ready",
      checkpoint: { root: f.root, provider: f.provider, run: run.runId, card: card.id, session },
      attempts: 1,
      blocked: f.blocked(),
    });
    // Parent intentionally terminates this actual owner with SQLite and SDK still alive.
    await new Promise<void>(() => {
      setInterval(() => {}, 1000);
    });
  }
}
