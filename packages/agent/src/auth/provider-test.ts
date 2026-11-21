import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentError, agentHttpStatus, mapAgentError } from "../core/errors.ts";
import type { AgentRuntime } from "../core/types.ts";

type PreparedTest = { runtime: ModelRuntime; model: Model<Api>; modelCount: number };

/**
 * Mac acceptance 2026-11-20: a slow model answering "Hi" in more than 10 s was reported as a
 * network failure. One attempt now gets 25 s; providers.test allows for up to three (404 fallback).
 */
const TEST_DEADLINE_MS = 25_000;

export async function testProviderModel(
  prepare: (signal: AbortSignal) => Promise<PreparedTest>,
  callerSignal?: AbortSignal,
): ReturnType<AgentRuntime["testProvider"]> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Timed out", "TimeoutError")),
    TEST_DEADLINE_MS,
  );
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    // Bound setup/key retrieval too; an uncancellable keyring wait must not start a late request.
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const probe = (async () => {
      const { runtime, model, modelCount } = await prepare(signal);
      signal.throwIfAborted();
      const result = await runtime.completeSimple(
        model,
        { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
        { maxTokens: 8, maxRetries: 0, timeoutMs: TEST_DEADLINE_MS, signal },
      );
      signal.throwIfAborted();
      if (result.stopReason === "aborted") throw new AgentError("aborted");
      if (result.stopReason === "error") {
        const code = mapAgentError(result.errorMessage);
        throw new AgentError(
          code === "internal" ? "provider_error" : code,
          agentHttpStatus(result.errorMessage),
        );
      }
      return { ok: true, modelCount };
    })();
    return await Promise.race([probe, stopped]);
  } catch (error) {
    const httpStatus = agentHttpStatus(error);
    return {
      ok: false,
      error: callerSignal?.aborted
        ? "aborted"
        : deadline.signal.aborted
          ? "network"
          : mapAgentError(error),
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
