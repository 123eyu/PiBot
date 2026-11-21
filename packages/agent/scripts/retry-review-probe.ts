import assert from "node:assert/strict";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { AgentError } from "../src/core/errors.ts";
import type { AgentRequestObserver } from "../src/core/types.ts";
import { RequestAccounting } from "../src/runtime/request-observer.ts";
import { CONNECTION_RETRY_DELAYS } from "../src/runtime/request-recovery.ts";
import { retryStream } from "../src/runtime/retry-stream.ts";
import { type ChatSession, wrapSession } from "../src/session/session.ts";

/** Manual boundary probe: synthetic SDK events, no credentials or external requests. */
export async function retryReviewProbe() {
  const model: Model<"openai-responses"> = {
    id: "synthetic",
    name: "synthetic",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "http://127.0.0.1:1",
    input: ["text"],
    reasoning: true,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  let passed = 0;
  for (const evidence of ["thinkingSignature", "textSignature"] as const) {
    for (const phase of ["event", "terminal"] as const) {
      await run({ evidence, phase, diagnostic: "Connection error.", code: "network" });
    }
  }
  for (const thrown of [false, true]) {
    for (const status of [undefined, 400]) {
      await run({
        diagnostic: `authentication failed: synthetic private diagnostic${status ? ` HTTP ${status}` : ""}`,
        code: "auth_failed",
        status,
        thrown,
      });
    }
  }
  for (const status of [503, 529])
    await run({ diagnostic: `HTTP ${status}`, code: "provider_overloaded", status });
  return passed;

  async function run(input: {
    diagnostic: string;
    code: "network" | "auth_failed" | "provider_overloaded";
    status?: number;
    thrown?: boolean;
    evidence?: "thinkingSignature" | "textSignature";
    phase?: "event" | "terminal";
  }) {
    const receipts: Parameters<AgentRequestObserver["settled"]>[0][] = [];
    const accounting = new RequestAccounting({
      beforeRequest() {},
      settled: (receipt) => {
        receipts.push(receipt);
      },
    });
    // Exercise exhausted retry classification without waiting through backoff per fixture.
    if (!input.evidence) accounting.retryAttempts = CONNECTION_RETRY_DELAYS.length;
    let calls = 0;
    let final: AssistantMessage | undefined;
    const empty: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
      stopReason: "error",
      errorMessage: input.diagnostic,
    };
    const signed: AssistantMessage = {
      ...empty,
      content:
        input.evidence === "thinkingSignature"
          ? [
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: "synthetic encrypted reasoning",
                redacted: true,
              },
            ]
          : [{ type: "text", text: "", textSignature: "synthetic signature" }],
    };
    const sdk: ChatSession = {
      messages: [],
      subscribe: () => () => {},
      abort: async () => {},
      waitForIdle: async () => {},
      dispose() {},
      async prompt() {
        const stream = retryStream({
          model,
          accounting,
          open() {
            calls++;
            if (input.thrown) throw new Error(input.diagnostic);
            const source = createAssistantMessageEventStream();
            if (input.phase === "event") source.push({ type: "start", partial: signed });
            source.push({
              type: "error",
              reason: "error",
              error: input.phase === "terminal" ? signed : empty,
            });
            source.end();
            return source;
          },
        });
        for await (const event of stream) {
          if (event.type === "error") final = event.error;
        }
        sdk.messages.push(await stream.result());
      },
    };
    const session = wrapSession(
      sdk,
      "synthetic",
      async () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      accounting,
    );
    try {
      await assert.rejects(
        session.prompt("synthetic", () => {}),
        new AgentError(input.code, input.status),
      );
      // A drop after output nobody saw is asked again twice (nothing in it ran); the
      // receipts still stay unpriced and the run still ends with the same code afterwards.
      const attempts = input.evidence ? 3 : 1;
      assert.equal(calls, attempts);
      assert.equal(receipts.length, attempts);
      if (input.evidence) {
        assert(receipts.every((receipt) => receipt.usage === undefined));
        assert.equal(accounting.retryAttempts, attempts - 1);
      }
      assert(final);
      assert(!final.errorMessage?.includes("synthetic private diagnostic"));
      assert.equal(accounting.responseError?.code, input.code);
      passed++;
    } finally {
      session.dispose();
    }
  }
}
