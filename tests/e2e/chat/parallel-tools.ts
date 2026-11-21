import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { LocalToolCall } from "../../../packages/agent/src/core/types.ts";
import { LocalRun } from "../../../packages/brain/src/runtime/tools/local-run.ts";
import type { AcceptanceResult } from "../supervisor.ts";
import { type Fixture, sessionEntries, until } from "./harness.ts";

type Metrics = NonNullable<AcceptanceResult["toolConcurrency"]>;
type Exercise = (
  name: string,
  scenario: string,
  action: (f: Fixture) => Promise<Metrics>,
) => Promise<void>;

/** A controlled delay at the authorized execution boundary makes overlap deterministic. */
function observeCalls(f: Fixture, delayMs: number) {
  const descriptor = Object.getOwnPropertyDescriptor(LocalRun.prototype, "execute");
  assert(descriptor && typeof descriptor.value === "function");
  const original = descriptor.value;
  const metrics: Metrics = { readPeak: 0, cancelled: 0 };
  let active = 0;
  let writes = 0;
  let writeOverlapped = false;
  const ids = new Set<string>();
  Object.defineProperty(LocalRun.prototype, "execute", {
    ...descriptor,
    async value(
      this: LocalRun,
      call: LocalToolCall,
      signal: AbortSignal,
      output: (text: string) => void,
    ) {
      const path = typeof call.input.path === "string" ? basename(call.input.path) : "";
      const reading = call.tool === "read_file" && /^parallel-[0-3]\.txt$/.test(path);
      const writing = call.tool === "write_file" && path === "parallel-output.txt";
      if (this.context.botId !== f.researcher.id || (!reading && !writing))
        return Reflect.apply(original, this, [call, signal, output]);
      if (reading) {
        assert(!ids.has(call.id), "读取调用不得重复执行");
        ids.add(call.id);
        active++;
        metrics.readPeak = Math.max(metrics.readPeak, active);
      } else {
        writes++;
        writeOverlapped ||= active > 0;
      }
      try {
        // Keep the real LocalRun revalidation, file IO, audit and result path after the delay.
        await wait(delayMs, undefined, { signal });
        return await Reflect.apply(original, this, [call, signal, output]);
      } catch (error) {
        if (reading && signal.aborted) metrics.cancelled++;
        throw error;
      } finally {
        if (reading) active--;
      }
    },
  });
  return {
    metrics,
    get active() {
      return active;
    },
    get writes() {
      return writes;
    },
    get writeOverlapped() {
      return writeOverlapped;
    },
    restore: () => Object.defineProperty(LocalRun.prototype, "execute", descriptor),
  };
}

async function terminal(f: Fixture, runId: string, messageId: string, topicId?: string) {
  await until(
    "并行读取运行真实终态",
    () => f.client.call("chat.runs", { botId: f.researcher.id }),
    (runs) => runs.some((run) => run.id === runId && !["queued", "running"].includes(run.status)),
  );
  const rows = await f.client.call("chat.history", { botId: f.researcher.id, topicId });
  const message = rows.find((row) => row.id === messageId);
  assert(message && message.status !== "streaming");
  return message;
}

async function paired(f: Fixture) {
  const calls: string[] = [],
    results: string[] = [];
  for (const entry of await sessionEntries(f.root)) {
    const message = entry.message as
      | {
          role?: string;
          toolCallId?: string;
          content?: { type: string; name?: string; id?: string }[];
        }
      | undefined;
    if (message?.role === "assistant" && Array.isArray(message.content))
      for (const block of message.content)
        if (block.type === "toolCall" && block.name === "read_file" && block.id)
          calls.push(block.id);
    if (message?.role === "toolResult" && message.toolCallId) results.push(message.toolCallId);
  }
  assert.equal(calls.length, 4);
  for (const id of calls) assert.equal(results.filter((result) => result === id).length, 1);
}

export async function parallelToolScenarios(exercise: Exercise) {
  for (const mode of ["reads", "mixed", "cancel"] as const)
    await exercise(`只读并行 · ${mode}`, `parallel-${mode}`, async (f) => {
      for (let i = 0; i < 4; i++)
        await writeFile(join(f.root, `parallel-${i}.txt`), `synthetic ${i}\n`);
      const monitor = observeCalls(f, mode === "cancel" ? 10_000 : 100);
      try {
        const receipt = await f.client.call("chat.send", {
          botId: f.researcher.id,
          text: "执行本场合成文件读取剧本",
        });
        if (mode === "mixed") {
          const cards = await until(
            "混合批次写入审批",
            () => f.client.call("approvals.pending", {}),
            (cards) => cards.some((card) => card.runId === receipt.runId),
          );
          assert.equal(cards.length, 1);
          const card = cards[0];
          assert(card && card.category === "write_file");
          assert.equal(monitor.active, 0);
          assert.equal(monitor.writes, 0, "审批前不能写入");
          await f.client.call("approvals.resolve", {
            id: card.id,
            decision: "allow",
            remember: false,
          });
        } else if (mode === "cancel") {
          await until(
            "四个读取都在执行",
            async () => monitor.active,
            (active) => active === 4,
          );
          await f.client.call("chat.abort", { runId: receipt.runId });
        }
        const message = await terminal(
          f,
          receipt.runId,
          receipt.assistantMessageId,
          receipt.conversationId,
        );
        assert.equal(message.status, mode === "cancel" ? "aborted" : "done");
        assert.equal(monitor.active, 0);
        assert.equal(monitor.metrics.readPeak, mode === "mixed" ? 1 : 4);
        assert.equal(monitor.metrics.cancelled, mode === "cancel" ? 4 : 0);
        assert.equal(monitor.writeOverlapped, false);
        if (mode === "mixed") {
          assert.equal(monitor.writes, 1);
          assert.equal(
            await readFile(join(f.root, "parallel-output.txt"), "utf8"),
            "synthetic output\n",
          );
        }
        assert.equal((await f.client.call("approvals.pending", {})).length, 0);
        await paired(f);
        return monitor.metrics;
      } finally {
        monitor.restore();
      }
    });
}
