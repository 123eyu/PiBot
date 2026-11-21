import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { fixture, until } from "../chat/harness.ts";

/** Runs the `receipt` scenario and checks the receipt against the records it is built from. */
export async function runReceiptProbe(root: string) {
  const f = await fixture("receipt", root);
  try {
    const sent = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "RECEIPT-PROBE-PROMPT 写文件并运行命令",
    });
    let approved = 0;
    const reply = await until(
      "收据演练回复终态",
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
          topicId: sent.conversationId,
        });
        return rows.find((row) => row.id === sent.assistantMessageId);
      },
      (row) => !!row && row.status !== "streaming",
    );
    assert(reply?.runId, "回复带运行 ID");
    assert.equal(reply.status, "done");
    const runId = reply.runId;
    // The run's turn record is written after the reply settles; give it a moment.
    await wait(300);

    const coldStart = performance.now();
    const receipt = await f.client.call("runs.receipt", { runId });
    const coldMs = performance.now() - coldStart;
    const warmStart = performance.now();
    const again = await f.client.call("runs.receipt", { runId });
    const warmMs = performance.now() - warmStart;
    assert.deepEqual(again, receipt, "未变化的运行复用缓存收据");

    // The records the receipt claims to summarize, read through their own RPCs.
    const audit = (
      await f.client.call("audit.list", { botId: f.researcher.id, limit: 200 })
    ).filter((entry) => entry.runId === runId);
    const of = (kind: string) => audit.filter((entry) => entry.kind === kind);
    const commands = of("exec.finished").filter(
      (entry) => entry.detail.toolName === "run_command" && entry.detail.toolCallId,
    );
    const conversationId = reply.conversationId;
    const turn = await f.client.call("changes.turn", { runId });
    const budget = await f.client.call("execution.budget.get", {
      botId: f.researcher.id,
      conversationId,
      runId,
    });
    const evidence = await f.client.call("deliveryEvidence.list", {
      botId: f.researcher.id,
      conversationId,
    });
    const unverified = evidence.items.filter(
      (item) => item.kind === "unverified" && item.runId === runId,
    );

    if (process.argv.includes("--verbose"))
      console.error(
        JSON.stringify(
          {
            receipt,
            audit: audit.map((e) => [e.kind, e.detail.toolName, e.detail.path ? "path" : ""]),
          },
          null,
          1,
        ),
      );
    assert.equal(receipt.runId, runId);
    assert.equal(receipt.messageId, reply.id);
    assert.equal(receipt.outcome, "done");
    assert.equal(receipt.source, "chat");
    assert.equal(receipt.inputs.files.total, of("file.read").length, "读取文件数 = file.read 审计");
    assert.equal(receipt.inputs.files.total, 1);
    assert.equal(receipt.outputs.filesTotal, turn.total, "改动文件数 = changes.turn");
    // The fixture's own HTTP log sits in the workplace, so the command watch records it too.
    const written = receipt.outputs.files.find((file) => file.path === "receipt-probe.md");
    assert.equal(written?.kind, "add", "写入的文件出现在产出里");
    assert.equal(written?.added, 2);
    assert.equal(
      receipt.outputs.added,
      turn.files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      "新增行数 = changes.turn",
    );
    assert.equal(receipt.actions.commands, commands.length, "命令数 = exec.finished 审计");
    assert.equal(receipt.actions.commands, 1);
    assert.equal(receipt.approvals.asked, approved, "审批数 = 实际处理的审批卡");
    assert.equal(receipt.approvals.allowed, approved);
    assert.equal(
      receipt.approvals.allowed,
      of("approval.resolved").filter((entry) => entry.detail.decision !== "deny").length,
      "允许数 = approval.resolved 审计",
    );
    assert(budget, "运行有预算账本");
    assert(receipt.cost, "收据带花费");
    assert.equal(receipt.cost.requests, budget.requests, "请求数 = 预算账本");
    assert.equal(receipt.cost.tokens, Math.round(budget.observedTokens), "令牌 = 预算账本");
    assert.equal(receipt.model?.id, "researcher", "模型来自运行记录");
    assert.equal(receipt.unverified.total, unverified.length, "未核实 = 交付证据");
    assert.equal(receipt.unverified.total, 1);

    // No message text, prompt or file content: only categories, counts, folders and labels.
    const text = JSON.stringify(receipt);
    for (const secret of [
      "RECEIPT-PROBE-PROMPT",
      "RECEIPT-PROBE-REPLY",
      "RECEIPT-PROBE-CONTENT",
      "synthetic-chat-key-only",
    ])
      assert(!text.includes(secret), `收据不得包含 ${secret}`);

    return {
      scenario: "工作收据",
      status: "脚本化通过",
      receipt: {
        inputs: { files: receipt.inputs.files.total },
        outputs: {
          files: receipt.outputs.filesTotal,
          added: receipt.outputs.added,
          removed: receipt.outputs.removed,
        },
        approvals: receipt.approvals,
        commands: receipt.actions.commands,
        cost: receipt.cost,
        model: receipt.model?.id,
        unverified: receipt.unverified.total,
        bytes: text.length,
      },
      records: {
        fileReads: of("file.read").length,
        turnFiles: turn.total,
        commands: commands.length,
        approvalsResolved: of("approval.resolved").length,
        budgetRequests: budget.requests,
        unverifiedEvidence: unverified.length,
      },
      timingMs: { cold: Math.round(coldMs * 10) / 10, cached: Math.round(warmMs * 10) / 10 },
      nonFixtureNetworkAttempts: f.blocked(),
    };
  } finally {
    await f.cleanup();
  }
}
