import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { AgentError } from "../../packages/agent/src/core/errors.ts";
import { SUMMARY_IDLE_MS } from "../../packages/agent/src/extensions/checkpoint-request.ts";
import { CheckpointCache } from "../../packages/agent/src/extensions/checkpoint-result.ts";
import {
  type SummaryInput,
  summarizeCheckpoint,
} from "../../packages/agent/src/extensions/checkpoint-summary.ts";
import type { CompactionState } from "../../packages/agent/src/extensions/compaction.ts";
import { historyTokens } from "../../packages/agent/src/runtime/context-estimate.ts";
import { loadScenario, type Reply } from "../../tools/fake-llm/scenario.ts";

type Registry = Parameters<typeof summarizeCheckpoint>[1];
type Model = Parameters<typeof summarizeCheckpoint>[2];
type Response = Awaited<ReturnType<ReturnType<Registry["streamSimple"]>["result"]>>;
const model: Model = {
  id: "fixture",
  name: "fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "http://127.0.0.1",
  reasoning: false,
  input: ["text"],
  contextWindow: 32768,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text: string): Response => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: structuredClone(usage),
  stopReason: "stop",
  timestamp: Date.now(),
});
const input: SummaryInput = {
  messages: [
    { role: "user", content: "keep the source path", timestamp: 1 },
    assistant("recorded work"),
  ],
  users: [],
};

/** An in-process fake provider uses the same JSON scripts and stream contract. No credentials/network. */
function provider(replies: Reply[]) {
  let calls = 0;
  const texts: string[] = [];
  const registry = {
    streamSimple(
      _model: Model,
      context: { messages: { content: { text: string }[] }[] },
      options: { signal: AbortSignal },
    ) {
      texts.push(context.messages[0]?.content[0]?.text ?? "");
      const reply = replies[Math.min(calls++, replies.length - 1)] as Reply;
      if (reply.httpError)
        throw new AgentError(
          reply.httpError === "rate_limited" ? "rate_limited" : "provider_error",
        );
      let complete: (value: Response) => void = () => {};
      const result = new Promise<Response>((resolve) => {
        complete = resolve;
      });
      const stream = {
        result: () => result,
        async *[Symbol.asyncIterator]() {
          let response = assistant("");
          try {
            if (reply.hang || reply.pauseMs)
              await delay(reply.pauseMs ?? 10000, undefined, { signal: options.signal });
            for (const delta of Array.from(reply.text ?? "")) {
              await delay(reply.delayMs ?? 0, undefined, { signal: options.signal });
              yield { type: "text_delta", delta };
            }
            response = {
              ...assistant(reply.text ?? ""),
              stopReason: reply.toolCalls
                ? "toolUse"
                : reply.finishReason === "malformed_function_call"
                  ? "error"
                  : (reply.finishReason ?? "stop"),
            };
          } catch {
            response = { ...response, stopReason: "aborted" };
          } finally {
            complete(response);
          }
        },
      };
      return stream;
    },
  } as unknown as Registry;
  return { registry, calls: () => calls, texts };
}
export async function runCompactionReliability() {
  const scenario = await loadScenario("compaction-reliability");
  assert.equal(SUMMARY_IDLE_MS, 90000);
  const receipts: string[] = [];
  for (const route of ["slow", "idle", "hang", "retry", "length", "toolUse", "missing"]) {
    const fake = provider(scenario.routes?.[route] ?? []);
    const state: CompactionState = {
      redact: (text) => text.replaceAll("fixture-secret", "[redacted]"),
      timing: { idleMs: 60, retryMs: 1 },
    };
    const source =
      route === "missing"
        ? {
            ...input,
            messages: [
              {
                ...assistant(""),
                content: [
                  {
                    type: "toolCall" as const,
                    id: "missing",
                    name: "read_file",
                    arguments: { path: "fixture-secret" },
                  },
                ],
              },
            ],
          }
        : input;
    const result = await summarizeCheckpoint(source, fake.registry, model, state);
    assert.equal(!!result.details.mechanical, route === "idle" || route === "hang");
    if (route === "retry" || route === "length") assert.equal(fake.calls(), 2);
    if (route === "missing") {
      assert(fake.texts[0]?.includes("result not recorded"));
      assert(!fake.texts.join().includes("fixture-secret"));
    }
    receipts.push(route);
  }
  const slow = provider(scenario.routes?.slow ?? []);
  const timed = await summarizeCheckpoint(input, slow.registry, model, {
    redact: (text) => text,
    timing: { idleMs: 60, totalMs: 75 },
  });
  assert(timed.details.mechanical);
  receipts.push("slow-total-timeout");
  const large: SummaryInput = { messages: [], users: [] };
  while (historyTokens(large.messages) < 150000)
    large.messages.push(
      { role: "user", content: "evidence ".repeat(2500), timestamp: large.messages.length },
      assistant("recorded outcome"),
    );
  const fake = provider(scenario.routes?.large ?? []);
  let persisted = 0;
  await summarizeCheckpoint(large, fake.registry, model, {
    redact: (text) => text,
    progress: async () => {
      persisted++;
    },
  });
  assert(fake.calls() > 8);
  assert.equal(persisted, fake.calls());
  receipts.push("150k-to-32k");
  const partial = provider(scenario.routes?.partial ?? []),
    cache = new CheckpointCache();
  const state: CompactionState = {
    redact: (text) => text,
    cache,
    identity: () => "fixture-session",
    timing: { retryMs: 1 },
  };
  const result = await summarizeCheckpoint(large, partial.registry, model, state);
  assert(!result.complete);
  assert(result.consumedMessages > 0);
  assert.equal(partial.calls(), 4);
  const rest = provider([{ text: "remaining checkpoint" }]);
  const resumed = await summarizeCheckpoint(large, rest.registry, model, state);
  assert(resumed.complete);
  assert(rest.calls() < fake.calls());
  receipts.push("partial-resume");
  const unattended = provider(scenario.routes?.partial ?? []);
  const fallback = await summarizeCheckpoint(large, unattended.registry, model, {
    redact: (text) => text,
    unattended: true,
    timing: { retryMs: 1 },
  });
  assert(fallback.complete && fallback.details.mechanical);
  receipts.push("unattended-fallback");
  const cancelled = new AbortController(),
    saved = new CheckpointCache(),
    active = provider([{ text: "completed checkpoint" }]);
  await assert.rejects(
    summarizeCheckpoint(large, active.registry, model, {
      redact: (text) => text,
      cache: saved,
      signal: cancelled.signal,
      progress: async () => cancelled.abort(),
    }),
    (error: unknown) => error instanceof AgentError && error.code === "aborted",
  );
  assert.equal(active.calls(), 1);
  receipts.push("cancel-after-progress");
  return receipts;
}
