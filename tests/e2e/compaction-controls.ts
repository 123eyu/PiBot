import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadScenario } from "../../tools/fake-llm/scenario.ts";
import { dmDone, fixture, until } from "./chat/harness.ts";
import { m3Fixture } from "./routines/fixture.ts";
import { draft, terminal } from "./routines/shared.ts";

export async function runCompactionControls(root: string) {
  const f = await fixture("compaction-controls", root);
  try {
    const first = await dmDone(f, "Keep the explicit constraints and verified work.");
    assert(first && first.status === "done");
    const botId = f.researcher.id,
      conversationId = first.conversationId;
    await assert.rejects(
      f.client.call("chat.compact", {
        botId: f.writer.id,
        conversationId,
        requestId: randomUUID(),
        fork: false,
      }),
    );
    const result = await f.client.call("chat.compact", {
      botId,
      conversationId,
      requestId: randomUUID(),
      fork: false,
    });
    assert.equal(result.conversationId, conversationId);
    const directory = join(f.root, "data", "bots", botId, "sessions");
    const hashes = new Map<string, string>();
    for (const name of await readdir(directory))
      if (name.endsWith(".jsonl"))
        hashes.set(
          name,
          createHash("sha256")
            .update(await readFile(join(directory, name)))
            .digest("hex"),
        );
    const fork = await f.client.call("chat.compact", {
      botId,
      conversationId,
      requestId: randomUUID(),
      fork: true,
    });
    assert.notEqual(fork.conversationId, conversationId);
    for (const [name, hash] of hashes)
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex"),
        hash,
        "fork must not modify its source",
      );
    const topics = await f.client.call("topics.list", { botId });
    assert(topics.some((topic) => topic.id === fork.conversationId && topic.isCurrent));
    const history = await f.client.call("chat.history", { botId, topicId: fork.conversationId });
    assert.equal(history.length, 1);
    assert(history[0]?.content.includes("Context handoff checkpoint"));
    assert.equal((await dmDone(f, "new recorded work after handoff"))?.status, "done");
    const requestsBeforeCancel = f.requests.length;
    const requestId = randomUUID();
    const cancel = f.client.call("chat.compact", {
      botId,
      conversationId: fork.conversationId,
      requestId,
      fork: false,
    });
    // Attach a rejection observer before waiting for the provider to avoid unhandled rejections.
    const refused = cancel.then(
      () => false,
      () => true,
    );
    await until(
      "manual summary started",
      async () => f.requests,
      (requests) => requests.length > requestsBeforeCancel,
    );
    await assert.rejects(
      f.client.call("chat.send", {
        botId,
        topicId: fork.conversationId,
        text: "must not interleave",
      }),
      "manual compaction holds the topic writer",
    );
    await f.client.call("chat.compact.cancel", {
      botId,
      conversationId: fork.conversationId,
      requestId,
    });
    assert.equal(await refused, true, "cancelled manual compaction must reject");
    assert.equal(f.blocked(), 0);
    return [
      "manual-compact",
      "source-preserving-handoff",
      "cancel-and-writer-lease",
      "scope-rejection",
    ];
  } finally {
    await f.cleanup();
  }
}

export async function runCompactionProgress(root: string) {
  const f = await fixture("compaction", root);
  try {
    const first = await dmDone(f, "recorded seed");
    assert(first && first.status === "done");
    const botId = f.researcher.id,
      conversationId = first.conversationId;
    const directory = join(f.root, "data", "bots", botId, "sessions");
    const name = (await readdir(directory)).find((name) => name.endsWith(".jsonl"));
    assert(name);
    const file = join(directory, name),
      original = await readFile(file, "utf8");
    const entries = original
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const assistant = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    assert(user && assistant);
    let parentId = entries.at(-1).id;
    const extra = [];
    // Synthetic offline history exceeds 150k tokens before selecting the 32k fixture model.
    for (let i = 0; i < 40; i++) {
      for (const source of [user, assistant]) {
        const id = randomUUID().replaceAll("-", "").slice(0, 8);
        extra.push(
          JSON.stringify({
            ...source,
            id,
            parentId,
            message: {
              ...source.message,
              content: [
                {
                  type: "text",
                  text: source === user ? "evidence ".repeat(2500) : "recorded outcome",
                },
              ],
            },
          }),
        );
        parentId = id;
      }
    }
    await appendFile(file, `${extra.join("\n")}\n`);
    const source = await readFile(file, "utf8");
    await f.client.call(
      "chat.compact",
      { botId, conversationId, requestId: randomUUID(), fork: false },
      { timeoutMs: 120000 },
    );
    const after = await readFile(file, "utf8");
    assert(after.startsWith(source), "checkpoint writes are append-only");
    const checkpoints = after
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "compaction");
    assert(checkpoints.length > 8, "every completed block is persisted through the public SDK");
    assert.equal(
      checkpoints.reduce((sum, entry) => sum + (entry.usage?.output ?? 0), 0),
      (f.requests.length - 1) * 20,
      "chunk usage must not be counted cumulatively",
    );
    assert.equal((await dmDone(f, "continue from the checkpoint"))?.status, "done");
    assert.equal(f.blocked(), 0);
    return ["sdk-per-block-persistence", "sdk-append-only-and-usage", "sdk-small-window-reopen"];
  } finally {
    await f.cleanup();
  }
}

export async function runRoutineCompaction(root: string) {
  const f = await m3Fixture(root);
  try {
    const path = join(f.primary, "recorded-evidence.txt");
    await writeFile(path, "recorded evidence only");
    const script = await loadScenario("compaction-reliability");
    const failure = script.routes?.unattended?.[0];
    assert(failure);
    await f.replies([
      {
        text: "recorded evidence ".repeat(3500),
        toolCalls: [{ name: "read_file", arguments: { path } }],
        promptTokens: 26000,
        delayMs: 0,
      },
      failure,
      failure,
      failure,
      { text: "routine continued from the mechanical checkpoint", delayMs: 0 },
    ]);
    const routine = await f.rpc.call("routines.create", draft(f));
    const receipt = await f.rpc.call("routines.runNow", { id: routine.id });
    const run = await terminal(f, receipt.runId).catch(async () => {
      const actual = f.service.runs.require(receipt.runId);
      throw new Error(
        `routine timeout: ${JSON.stringify({ status: actual.status, requests: f.requests.length, approvals: (await f.rpc.call("approvals.pending", {})).length })}`,
      );
    });
    assert.equal(run.status, "done", "routine must continue after summary provider failure");
    const row = f.db.prepare("SELECT session_file file FROM runs WHERE id=?").get(run.runId);
    const entries = (await readFile(join(f.root, "data", String(row?.file)), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      entries.some((entry) => entry.type === "compaction" && entry.details?.mechanical),
      "routine must persist a mechanical checkpoint",
    );
    assert(
      f.requests.some((request) =>
        JSON.stringify(request.body).includes("Model summary unavailable"),
      ),
      "the following request uses the fallback checkpoint",
    );
    assert.equal(f.blocked(), 0);
    return ["routine-provider-failure-mechanical-fallback"];
  } finally {
    await f.cleanup();
  }
}
