import assert from "node:assert/strict";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { memoryVertex } from "../src/auth/vertex-memory.ts";
import type { AgentAuthPorts } from "../src/core/types.ts";
import { installAgentNetwork } from "../src/network/network.ts";
import { RequestAccounting } from "../src/runtime/request-observer.ts";
import { retryStream } from "../src/runtime/retry-stream.ts";

/** Real Google SDK over an in-memory fetch: no sockets, ADC, credentials or user directories. */
export async function vertexRecoveryProbe() {
  const model: Model<"google-vertex"> = {
    id: "gemini-3.5-flash",
    name: "synthetic",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://aiplatform.googleapis.com",
    input: ["text"],
    reasoning: false,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 100,
  };
  const unsupported = (): never => {
    throw new Error("Unused fixture stream");
  };
  const base: Provider = {
    id: "google-vertex",
    name: "synthetic",
    auth: {},
    getModels: () => [model],
    stream: unsupported,
    streamSimple: unsupported,
  };
  const auth = {
    cloud: async () => ({
      providerId: "google-vertex",
      env: { GOOGLE_CLOUD_PROJECT: "synthetic", GOOGLE_CLOUD_LOCATION: "global" },
      googleCredentials: { synthetic: "unused" },
    }),
  } as unknown as AgentAuthPorts;
  const reports: unknown[] = [];
  for (const mode of ["429", "malformed"] as const) {
    let calls = 0;
    const times: number[] = [];
    const network = installAgentNetwork(
      async (url) => {
        assert(String(url).startsWith("https://aiplatform.googleapis.com/"));
        times.push(performance.now());
        calls++;
        if (mode === "429" && calls <= 2)
          return new Response(JSON.stringify({ error: { code: 429, message: "synthetic" } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "0.05" },
          });
        const malformed = mode === "malformed" && calls === 1;
        return new Response(
          `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: malformed ? [] : [{ text: "ok" }] }, finishReason: malformed ? "MALFORMED_FUNCTION_CALL" : "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      () => false,
    );
    try {
      const vertex = network.wrap(memoryVertex(base, auth, { token: async () => "synthetic" }));
      const accounting = new RequestAccounting();
      const stream = retryStream({
        model,
        accounting,
        signal: AbortSignal.timeout(10000),
        open(recovery) {
          if (mode === "malformed" && calls > 0) assert(recovery.hint?.includes("Resend"));
          return vertex.streamSimple(
            model,
            normalizeContext({
              messages: [{ role: "user", content: recovery.hint ?? "fixture", timestamp: 0 }],
            }),
            { maxRetries: 0, onResponse: recovery.response },
          );
        },
      });
      for await (const _event of stream) {
        /* Consume the owned stream through its terminal. */
      }
      assert.equal((await stream.result()).stopReason, "stop");
      await accounting.drain();
      assert.equal(calls, mode === "429" ? 3 : 2);
      if (mode === "429") assert((times[1] ?? 0) - (times[0] ?? 0) >= 45);
      reports.push({ mode, requests: calls, stopReason: "stop" });
    } finally {
      network.dispose();
    }
  }
  return reports;
}
