import { bridgeApproval } from "./approval.ts";
import { createApprovalRequests } from "./approval-requests.ts";
import type { PromptTurnContext, PromptTurnResult } from "./prompt-turn.ts";
import { waitForResponse } from "./request-wait.ts";
import type { AcpGroupRunReceipt, AcpGroupSnapshot, AcpRuntimeEvent } from "./types.ts";

/** Snapshot membership authorizes output; group/topic hints only select a bounded holding buffer. */
export function groupTurnOutput(
  context: PromptTurnContext,
  signal: AbortSignal,
  fail: (kind: "capacity" | "transport") => void,
) {
  const permissions = createApprovalRequests(signal);
  const known = new Set<string>();
  const members = new Set<string>([context.state.botId]);
  const waiting: { event: AcpRuntimeEvent; serial: number; size: number }[] = [];
  let serial = 0;
  const waitingApprovals = new Set<string>(),
    resolved = new Set<string>();
  const ended = new Set<string>();
  const totals: NonNullable<NonNullable<PromptTurnResult["_meta"]>["pibot/usage"]> = {
    requests: 0,
  };
  const invalidUsage = new Set<string>();
  let hasUsage = false;
  let receipt: AcpGroupRunReceipt | undefined;
  let chain = Promise.resolve();
  let count = 0,
    bytes = 0,
    waitingBytes = 0;
  const maxEvents = Math.min(context.options.outputBudget?.events ?? 256, 256);
  const maxBytes = Math.min(context.options.outputBudget?.bytes ?? 1024 * 1024, 1024 * 1024);
  const toolId = (event: Extract<AcpRuntimeEvent, { method: "chat.tool" }>) =>
    `${event.payload.runId}:${event.payload.toolCallId}`;
  const route = async (event: AcpRuntimeEvent) => {
    if (signal.aborted || event.method === "approval.resolved") return;
    const payload = event.payload;
    if (event.method === "chat.delta")
      await context.notify(
        context.state.id,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: `${payload.runId}:${event.payload.messageId}`,
          content: { type: "text", text: event.payload.text },
        },
        signal,
      );
    else if (event.method === "chat.tool") {
      const p = event.payload;
      await context.notify(
        context.state.id,
        p.phase === "start"
          ? {
              sessionUpdate: "tool_call",
              toolCallId: toolId(event),
              title: p.summary || p.tool,
              name: p.tool,
              kind: p.tool.includes("read") ? "read" : "other",
              status: "in_progress",
            }
          : {
              sessionUpdate: "tool_call_update",
              toolCallId: toolId(event),
              status:
                p.phase === "end" ? (p.status === "done" ? "completed" : "failed") : "in_progress",
              ...(p.output === undefined ? {} : { rawOutput: p.output }),
            },
        signal,
      );
    } else if (event.method === "approval.requested") {
      await bridgeApproval(
        {
          clientPort: context.clientPort(),
          permissions,
          runtime: context.options.runtime,
          sessionId: context.state.id,
          locale: context.locale(),
          turnSignal: signal,
        },
        { ...event.payload, toolCallId: `${event.payload.runId}:${event.payload.toolCallId}` },
      );
    } else if (event.method === "chat.done" && !ended.has(payload.runId)) {
      ended.add(payload.runId);
      const usage = event.payload.usage;
      if (usage && typeof usage === "object") {
        hasUsage = true;
        totals.requests++;
        const fields = usage as Record<string, unknown>;
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = fields[key];
          if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            invalidUsage.has(key)
          )
            continue;
          const next = (totals[key] ?? 0) + value;
          if (Number.isFinite(next)) totals[key] = next;
          else {
            delete totals[key];
            invalidUsage.add(key);
          }
        }
      }
    }
    // A member's done/error never settles a group. Only the owner's cycle snapshot can do so.
  };
  const enqueue = (event: AcpRuntimeEvent) => {
    if (signal.aborted) return;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (count + waiting.length >= maxEvents || bytes + waitingBytes + size > maxBytes) {
      fail("capacity");
      return;
    }
    if (event.method === "approval.requested") {
      permissions.track(event.payload.id);
      if (resolved.has(event.payload.id)) permissions.resolved(event.payload.id);
    }
    count++;
    bytes += size;
    chain = chain
      .then(() => route(event))
      .finally(() => {
        count--;
        bytes -= size;
      })
      .catch(() => {
        if (!signal.aborted) fail("transport");
      });
  };
  const receive = (event: AcpRuntimeEvent) => {
    if (signal.aborted) return;
    if (event.method === "approval.resolved") {
      permissions.resolved(event.payload.id);
      if (waitingApprovals.has(event.payload.id)) resolved.add(event.payload.id);
      return;
    }
    const p = event.payload;
    if (receipt && p.cycleId && p.cycleId !== receipt.cycleId) return;
    if (
      p.groupId &&
      context.state.target?.kind === "group" &&
      p.groupId !== context.state.target.groupId
    )
      return;
    if (known.has(p.runId)) {
      enqueue(event);
      return;
    }
    const groupId =
      context.state.target?.kind === "group" ? context.state.target.groupId : undefined;
    if (
      p.groupId !== groupId &&
      !(p.botId === context.state.botId && p.conversationId === context.topicId) &&
      // Production approval events carry Bot/run identity but no conversation/group route.
      !(
        event.method === "approval.requested" &&
        !p.groupId &&
        !p.conversationId &&
        p.botId &&
        members.has(p.botId)
      )
    )
      return;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (count + waiting.length >= maxEvents || bytes + waitingBytes + size > maxBytes) {
      fail("capacity");
      return;
    }
    waiting.push({ event, serial: ++serial, size });
    waitingBytes += size;
    if (event.method === "approval.requested") waitingApprovals.add(event.payload.id);
  };
  return {
    receive,
    members(ids: string[]) {
      if (ids.length > 1024) {
        fail("capacity");
        return;
      }
      for (const id of ids) members.add(id);
    },
    bind(current: AcpGroupRunReceipt) {
      receipt = current;
      for (const id of current.runIds) known.add(id);
    },
    startRead: () => serial,
    refresh(snapshot: AcpGroupSnapshot, readVersion: number) {
      for (const id of snapshot.runIds) known.add(id);
      if (known.size > 1024) {
        fail("capacity");
        return;
      }
      const buffered = waiting.splice(0);
      waitingBytes = 0;
      for (const item of buffered) {
        if (item.event.method !== "approval.resolved" && known.has(item.event.payload.runId))
          enqueue(item.event);
        else if (item.serial > readVersion) {
          waiting.push(item);
          waitingBytes += item.size;
        }
      }
      // An event arriving during snapshot IO waits for a snapshot dispatched after that event.
      // Runs omitted by that later authoritative read belong elsewhere and are never published.
      waitingApprovals.clear();
      for (const item of waiting)
        if (item.event.method === "approval.requested") waitingApprovals.add(item.event.payload.id);
      for (const id of resolved) if (!waitingApprovals.has(id)) resolved.delete(id);
    },
    usage: () => (hasUsage ? totals : undefined),
    async drain() {
      await waitForResponse(chain, signal);
    },
    dispose() {
      permissions.dispose();
      waiting.length = 0;
      waitingApprovals.clear();
      resolved.clear();
    },
  };
}
