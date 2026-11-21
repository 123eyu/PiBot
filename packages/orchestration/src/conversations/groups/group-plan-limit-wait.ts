// Card choices wait for the source's real terminal state and queue cleanup before admitting more work.
import { setTimeout as delay } from "node:timers/promises";
import { RpcError } from "@pibot/protocol-base";
import type { GroupService } from "./group-service.ts";

export async function waitPlanLimitSource(
  service: GroupService,
  sourceRunId: string,
  signal: AbortSignal,
) {
  const deadline = AbortSignal.any([signal, service.signal, AbortSignal.timeout(60_000)]);
  try {
    for (;;) {
      deadline.throwIfAborted();
      const source = service.runs.get(sourceRunId);
      if (!source) throw new RpcError(-32602, "question_changed");
      if (
        ["done", "error", "aborted"].includes(source.status) &&
        service.deps.chat.queue.canContinue(source.botId, source.conversationId)
      )
        return source;
      await delay(100, undefined, { signal: deadline });
    }
  } catch (error) {
    signal.throwIfAborted();
    service.signal.throwIfAborted();
    if (deadline.aborted) throw new RpcError(-32011, "question_busy");
    throw error;
  }
}
