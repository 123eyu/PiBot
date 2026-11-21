import { waitForResponse } from "./request-wait.ts";

export type AcpDebugEvent = "permission_response_ignored";

/** Resolutions bypass the turn's serial output queue, which may be waiting on this permission. */
export function createApprovalRequests(signal: AbortSignal) {
  const pending = new Map<string, { cancel: AbortController; resolved: boolean }>();
  return {
    track(id: string) {
      if (!pending.has(id)) pending.set(id, { cancel: new AbortController(), resolved: false });
    },
    resolved(id: string) {
      const request = pending.get(id);
      if (!request) return;
      request.resolved = true;
      request.cancel.abort();
    },
    async request(
      id: string,
      ask: (signal: AbortSignal) => Promise<unknown>,
      answer: (outcome: unknown) => Promise<void>,
    ) {
      const request = pending.get(id);
      if (!request) return;
      if (request.resolved || signal.aborted) {
        pending.delete(id);
        return;
      }
      const waiting = AbortSignal.any([signal, request.cancel.signal]);
      try {
        waiting.throwIfAborted();
        const response = ask(waiting);
        const outcome = await waitForResponse(response, waiting);
        if (request.resolved || waiting.aborted) return;
        await answer(outcome);
      } catch (error) {
        // Desktop may win between the editor's response and the brain's pending-state check.
        if (!request.resolved && !signal.aborted) throw error;
      } finally {
        pending.delete(id);
      }
    },
    dispose() {
      for (const request of pending.values()) request.cancel.abort();
      pending.clear();
    },
  };
}
