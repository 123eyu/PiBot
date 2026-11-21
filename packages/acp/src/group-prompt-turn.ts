import { setTimeout as pause } from "node:timers/promises";
import { RequestError } from "@agentclientprotocol/sdk";
import { acpFailure } from "./errors.ts";
import { groupTurnOutput } from "./group-turn-output.ts";
import type { PromptTurnContext, PromptTurnResult } from "./prompt-turn.ts";
import type { AcpGroupRunReceipt, AcpGroupSnapshot } from "./types.ts";

/** Exact receipt identity is stable even while its owned member run set grows. */
function sameCycle(receipt: AcpGroupRunReceipt, snapshot: AcpGroupSnapshot) {
  if (
    snapshot.groupId !== receipt.groupId ||
    snapshot.topicId !== receipt.topicId ||
    snapshot.cycleId !== receipt.cycleId ||
    snapshot.budgetRootRunId !== receipt.budgetRootRunId ||
    snapshot.runId !== receipt.runId ||
    snapshot.assistantMessageId !== receipt.assistantMessageId ||
    snapshot.runIds.length > 1024 ||
    snapshot.runs.length > 1024 ||
    (snapshot.terminal && !["completed", "failed", "cancelled"].includes(snapshot.state)) ||
    (snapshot.terminal && snapshot.state === "completed" && !snapshot.complete) ||
    (snapshot.complete &&
      !(snapshot.state === "completed" && snapshot.terminal && snapshot.drained)) ||
    (snapshot.drained && snapshot.activeRunIds.length > 0)
  )
    throw new Error("group_receipt_mismatch");
}
export async function runGroupPromptTurn(context: PromptTurnContext): Promise<PromptTurnResult> {
  const { options, state } = context;
  const runtime = options.runtime;
  if (
    state.target?.kind !== "group" ||
    !runtime.sendGroupPrompt ||
    !runtime.groupSnapshot ||
    !runtime.cancelGroup
  )
    throw new RequestError(-32601, "Group ACP unavailable", { code: "group_unsupported" });
  const groupId = state.target.groupId;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    context.signal,
    context.lifetime,
    controller.signal,
    AbortSignal.timeout(options.promptTimeoutMs ?? 3 * 60 * 60_000),
  ]);
  let outputFailure: "capacity" | "transport" | undefined;
  const output = groupTurnOutput(context, signal, (kind) => {
    outputFailure = kind;
    controller.abort();
  });
  let receipt: AcpGroupRunReceipt | undefined, latest: AcpGroupSnapshot | undefined;
  let cancelWork: Promise<AcpGroupSnapshot> | undefined;
  let finished = false;
  let cleanupConfirmed = false;
  const identities = new Set<string>();
  const runs = new Map<string, AcpGroupSnapshot["runs"][number]>();
  const bound = new Set<string>();
  let lastMetadata = "";
  const update = async (snapshot: AcpGroupSnapshot, publish: boolean) => {
    if (!receipt) throw new Error("group_receipt_missing");
    sameCycle(receipt, snapshot);
    for (const id of snapshot.runIds) identities.add(id);
    for (const row of snapshot.runs) {
      runs.set(row.runId, row);
      if (!bound.has(row.runId)) {
        options.execution?.bindRun(row.runId, state.id);
        bound.add(row.runId);
      }
    }
    if (identities.size > 1024 || runs.size > 1024) throw new Error("group_output_capacity");
    latest = { ...snapshot, runIds: [...identities], runs: [...runs.values()] };
    // An idle plan can admit more work later; only a terminal cycle is drain evidence.
    if (snapshot.terminal && snapshot.drained) cleanupConfirmed = true;
    const metadata = JSON.stringify(latest);
    if (publish && metadata !== lastMetadata) {
      lastMetadata = metadata;
      await context.notify(
        state.id,
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `[group] ${snapshot.state}` },
          _meta: { "pibot/group": latest },
        },
        signal,
      );
    }
  };
  const cancel = () => {
    if (!receipt) return undefined;
    cancelWork ??= runtime.cancelGroup?.(receipt, AbortSignal.timeout(100_000));
    return cancelWork;
  };
  const stopped = () => {
    void cancel()?.catch(() => undefined);
  };
  signal.addEventListener("abort", stopped, { once: true });
  let drain!: () => void;
  const drained = new Promise<void>((resolve) => {
    drain = resolve;
  });
  context.prompts.add(drained);
  state.busy = true;
  state.activeAbort = controller;
  const off = runtime.onEvent(output.receive);
  try {
    signal.throwIfAborted();
    if (runtime.group) {
      const group = await runtime.group(groupId, signal);
      output.members(group.memberBotIds);
      signal.throwIfAborted();
    }
    // The runtime keeps the dispatch receipt even if cancellation arrives during chat.send.
    const started = await context.interactive(
      runtime
        .sendGroupPrompt({ groupId, topicId: context.topicId, text: context.text }, signal)
        .catch((error: unknown) => {
          // This owner refusal precedes admission. A missing receipt alone cannot prove that a
          // timeout or broken connection did not start work, so no other error gets this proof.
          if (
            error instanceof Error &&
            (error as { code?: unknown }).code === -32602 &&
            error.message === "group_topic_stale"
          ) {
            const failure = acpFailure(error);
            throw new RequestError(failure.code, failure.message, {
              code: "group_unavailable",
              "pibot/promptRejected": {
                sessionId: state.id,
                groupId,
                reason: "group_topic_stale",
              },
            });
          }
          throw error;
        }),
    );
    if (started.groupId !== groupId || started.topicId !== context.topicId)
      throw new Error("group_receipt_mismatch");
    receipt = started;
    state.groupRun = receipt;
    state.activeRun = receipt.runId;
    options.execution?.bindRun(receipt.runId, state.id);
    bound.add(receipt.runId);
    output.bind(receipt);
    if (signal.aborted) stopped();
    for (;;) {
      signal.throwIfAborted();
      const readVersion = output.startRead();
      const snapshot = await runtime.groupSnapshot(
        receipt,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );
      sameCycle(receipt, snapshot);
      output.refresh(snapshot, readVersion);
      await update(snapshot, true);
      if (snapshot.state === "failed" && !(snapshot.terminal && snapshot.drained))
        throw new RequestError(-32603, "Group work failed", { code: "group_failed" });
      if (
        snapshot.complete &&
        snapshot.terminal &&
        snapshot.drained &&
        snapshot.state === "completed"
      ) {
        await output.drain();
        finished = true;
        return {
          stopReason: "end_turn",
          _meta: {
            "pibot/group": latest as AcpGroupSnapshot,
            ...(output.usage() ? { "pibot/usage": output.usage() } : {}),
          },
        };
      }
      if (snapshot.terminal && snapshot.drained) {
        finished = true;
        if (snapshot.state === "cancelled")
          return { stopReason: "cancelled", _meta: { "pibot/group": latest as AcpGroupSnapshot } };
        throw new RequestError(-32603, "Group work failed", {
          code: "group_failed",
          "pibot/group": latest,
        });
      }
      await pause(250, undefined, { signal });
    }
  } catch (error) {
    if (!finished && receipt && !cleanupConfirmed) {
      try {
        const snapshot = await cancel();
        if (!snapshot) throw new Error("group_cancel_unavailable");
        await update(snapshot, false);
        if (!snapshot.terminal || !snapshot.drained) throw new Error("group_cleanup_unconfirmed");
      } catch {
        if (latest) latest = { ...latest, complete: false, terminal: false, drained: false };
        throw new RequestError(-32603, "Group cleanup unconfirmed", {
          code: "group_cleanup_unconfirmed",
          "pibot/group": latest,
        });
      }
    }
    if (signal.aborted && !outputFailure && cleanupConfirmed && latest)
      return { stopReason: "cancelled", _meta: { "pibot/group": latest } };
    if (error instanceof RequestError)
      throw new RequestError(error.code, error.message, {
        ...(error.data && typeof error.data === "object" ? error.data : {}),
        "pibot/group": latest,
      });
    throw new RequestError(-32603, "Group ACP failed", {
      code:
        outputFailure === "capacity"
          ? "group_output_capacity"
          : outputFailure
            ? "group_output_unavailable"
            : "group_failed",
      "pibot/group": latest,
    });
  } finally {
    signal.removeEventListener("abort", stopped);
    controller.abort();
    off();
    output.dispose();
    try {
      await output.drain();
    } catch {
      /* Aborted output is not evidence of brain drain. */
    }
    if (cleanupConfirmed) for (const runId of bound) options.execution?.releaseRun(runId);
    if (cleanupConfirmed || !receipt) {
      state.groupRun = undefined;
      state.activeRun = undefined;
    }
    state.activeAbort = undefined;
    state.busy = false;
    context.prompts.delete(drained);
    drain();
  }
}
