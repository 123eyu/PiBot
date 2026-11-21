/*
 * One ACP prompt turn: turn the request into a Bot run, stream the run's events back as ACP
 * session updates, bridge approvals, and settle on a stop reason. Everything here is per-turn
 * bookkeeping; the connection itself (sessions, modes, lifetime) stays in `server.ts`.
 */
import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import { bridgeApproval } from "./approval.ts";
import { createApprovalRequests } from "./approval-requests.ts";
import { runGroupPromptTurn } from "./group-prompt-turn.ts";
import { stopReason } from "./messages.ts";
import { waitForResponse } from "./request-wait.ts";
import type { AcpAgentOptions, SessionState } from "./state.ts";
import type { AcpClientPort, AcpGroupSnapshot, AcpRuntimeEvent } from "./types.ts";

export interface PromptTurnContext {
  options: AcpAgentOptions;
  lifetime: AbortSignal;
  /** Read late: the connection may still be initialising its client port when the turn starts. */
  locale(): "zh" | "en";
  clientPort(): AcpClientPort | undefined;
  prompts: Set<Promise<void>>;
  interactive<T>(promise: Promise<T>): Promise<T>;
  notify(sessionId: string, update: SessionUpdate, signal: AbortSignal): Promise<void>;
  state: SessionState;
  topicId: string;
  text: string;
  signal: AbortSignal;
}

export interface PromptTurnResult {
  stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled";
  _meta?: {
    "pibot/group"?: AcpGroupSnapshot;
    "pibot/usage"?: {
      requests: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
}

export async function runPromptTurn(context: PromptTurnContext): Promise<PromptTurnResult> {
  if (context.state.target?.kind === "group") return runGroupPromptTurn(context);
  const {
    options,
    lifetime,
    locale,
    clientPort,
    prompts,
    interactive,
    notify,
    state,
    topicId,
    text,
    signal,
  } = context;

  const turn = new AbortController();
  // A turn is a whole Bot run: coding tasks take longer than the 10 minutes that bound the
  // other ACP requests (pilot P2 was cut off mid-task at 600 s). The client can cancel.
  const turnSignal = AbortSignal.any([
    signal,
    turn.signal,
    lifetime,
    AbortSignal.timeout(options.promptTimeoutMs ?? 3 * 60 * 60 * 1000),
  ]);
  state.activeAbort = turn;
  state.busy = true;
  let drained!: () => void;
  const promptDrained = new Promise<void>((resolve) => (drained = resolve));
  prompts.add(promptDrained);
  const permissions = createApprovalRequests(turnSignal);

  let targetRun: string | undefined;
  let abortTask: Promise<void> | undefined;
  let settled = false;
  /** Set when the run itself failed (model network, missing key …): not the model refusing. */
  let runFailure: string | undefined;
  /**
   * Token usage of this turn, summed from `chat.done`. Only numbers leave the app —
   * the dev workflow prints the prompt-cache hit rate without reading the running database.
   */
  let usageTotals:
    | {
        requests: number;
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      }
    | undefined;
  let settle!: (reason: "end_turn" | "max_tokens" | "refusal" | "cancelled") => void;
  const finished = new Promise<"end_turn" | "max_tokens" | "refusal" | "cancelled">(
    (resolve) => (settle = resolve),
  );
  const early: AcpRuntimeEvent[] = [];
  let earlyOverflow = false;
  let chain = Promise.resolve();
  let queuedEvents = 0,
    queuedBytes = 0;
  const drainOutput = async () => {
    try {
      await waitForResponse(chain, turnSignal);
    } catch (error) {
      // Cancelled output is no longer a prerequisite for releasing execution resources.
      if (!turnSignal.aborted) throw error;
    }
  };
  const route = async (event: AcpRuntimeEvent) => {
    if (turnSignal.aborted) return;
    if (event.method === "approval.resolved") return;
    if (event.payload.runId !== targetRun) return;
    if (event.method === "chat.delta") {
      await notify(
        state.id,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: event.payload.messageId,
          content: { type: "text", text: event.payload.text },
        },
        turnSignal,
      );
    } else if (event.method === "chat.tool") {
      const phase = event.payload.phase;
      if (phase === "start")
        await notify(
          state.id,
          {
            sessionUpdate: "tool_call",
            toolCallId: event.payload.toolCallId,
            title: event.payload.summary || event.payload.tool,
            name: event.payload.tool,
            kind: event.payload.tool.includes("read") ? "read" : "other",
            status: "in_progress",
          },
          turnSignal,
        );
      else
        await notify(
          state.id,
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.payload.toolCallId,
            status:
              phase === "end"
                ? event.payload.status === "done"
                  ? "completed"
                  : "failed"
                : "in_progress",
            ...(event.payload.output === undefined ? {} : { rawOutput: event.payload.output }),
          },
          turnSignal,
        );
    } else if (event.method === "approval.requested") {
      await bridgeApproval(
        {
          clientPort: clientPort(),
          permissions,
          runtime: options.runtime,
          sessionId: state.id,
          locale: locale(),
          turnSignal,
        },
        event.payload,
      );
    } else if (event.method === "chat.done") {
      // `usage` is the run's provider-reported totals (input/output/cacheRead/
      // cacheWrite). Sum across the turn's runs; a field no run reported stays absent.
      const usage = event.payload.usage;
      if (usage && typeof usage === "object") {
        const fields = usage as Record<string, unknown>;
        usageTotals ??= { requests: 0 };
        usageTotals.requests += 1;
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = fields[key];
          if (typeof value === "number" && Number.isFinite(value))
            usageTotals[key] = (usageTotals[key] ?? 0) + value;
        }
      }
      if (!settled) {
        settled = true;
        settle(stopReason(event.payload.stopReason));
      }
    } else if (!settled) {
      settled = true;
      if (event.payload.code !== "aborted") runFailure = event.payload.code;
      settle(event.payload.code === "aborted" ? "cancelled" : "refusal");
    }
  };
  let unsubscribe = () => {};
  const receive = (event: AcpRuntimeEvent) => {
    if (turnSignal.aborted) return;
    if (event.method === "approval.resolved") {
      permissions.resolved(event.payload.id);
      return;
    }
    if (!targetRun) {
      // Current producers always include the route. Before chat.send returns its run id, only
      // this session's Bot/topic may consume the bounded request buffer; concurrent sessions
      // and unrelated product runs must not exhaust its budget.
      if (event.payload.botId !== state.botId || event.payload.conversationId !== topicId) return;
      if (early.length < 256) {
        if (event.method === "approval.requested") permissions.track(event.payload.id);
        early.push(event);
      } else earlyOverflow = true;
      return;
    }
    if (event.payload.runId !== targetRun) return;
    if (event.method === "approval.requested") permissions.track(event.payload.id);
    const bytes = options.outputBudget ? Buffer.byteLength(JSON.stringify(event)) : 0;
    if (
      options.outputBudget &&
      (queuedEvents >= options.outputBudget.events ||
        queuedBytes + bytes > options.outputBudget.bytes)
    ) {
      turn.abort();
      return;
    }
    queuedEvents++;
    queuedBytes += bytes;
    chain = chain
      .then(() => route(event))
      .finally(() => {
        queuedEvents--;
        queuedBytes -= bytes;
      })
      .catch(async () => {
        if (!settled) {
          settled = true;
          settle(turnSignal.aborted ? "cancelled" : "refusal");
        }
        turn.abort();
        await abortTask;
      });
  };
  const abortTurn = () => {
    if (!settled) {
      settled = true;
      settle("cancelled");
    }
    if (targetRun)
      abortTask ??= options.runtime
        .abort(targetRun, AbortSignal.timeout(5_000))
        .catch(() => undefined);
  };
  turnSignal.addEventListener("abort", abortTurn, { once: true });
  try {
    unsubscribe = options.runtime.onEvent(receive);
    // A prompt the caller cancelled before dispatch must not start a run; the
    // same signal still aborts the run if the cancellation arrives after sendPrompt returned.
    turnSignal.throwIfAborted();
    const receipt = await interactive(
      options.runtime.sendPrompt({ botId: state.botId, topicId, text }, turnSignal),
    );
    targetRun = receipt.runId;
    state.activeRun = receipt.runId;
    options.execution?.bindRun(receipt.runId, state.id);
    if (earlyOverflow) {
      abortTask = options.runtime
        .abort(receipt.runId, AbortSignal.timeout(5_000))
        .catch(() => undefined);
      if (!settled) {
        settled = true;
        settle("refusal");
      }
    }
    if (turnSignal.aborted) abortTurn();
    for (const event of early) await route(event);
    const reason = await finished;
    await drainOutput();
    // ACP's stop reasons have no "error"; a failed run answered as "refusal" sent clients
    // (and the self-iteration workflow) chasing a model refusal. Only the error code leaves the
    // app —
    // the message may quote provider text.
    if (runFailure)
      throw new RequestError(-32603, `Pi Bot run failed: ${runFailure}`, { code: runFailure });
    return {
      stopReason: reason,
      ...(usageTotals ? { _meta: { "pibot/usage": usageTotals } } : {}),
    };
  } catch (error) {
    const cancelled = turnSignal.aborted;
    turn.abort();
    if (cancelled) return { stopReason: "cancelled" };
    throw error;
  } finally {
    turnSignal.removeEventListener("abort", abortTurn);
    turn.abort();
    unsubscribe();
    permissions.dispose();
    try {
      await abortTask;
      await drainOutput();
      if (targetRun) options.execution?.releaseRun(targetRun);
    } finally {
      state.activeRun = undefined;
      state.activeAbort = undefined;
      state.busy = false;
      prompts.delete(promptDrained);
      drained();
    }
  }
}
