import type { ChatPeer } from "@pibot/client-core";
import type { MethodResults } from "@pibot/workspaces-contract/full";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangesTarget } from "../store.ts";

export type ReviewerList = MethodResults["changes.reviewers"];

/**
 * Who can review a direct chat's code. Groups keep their coordinator's own dispatch, so
 * they get no list and the pane shows the plain button. A failed read also falls back to it.
 */
export function useReviewers(peer: ChatPeer, target: ChangesTarget) {
  const [list, setList] = useState<ReviewerList>();
  const reading = useRef<AbortController>(undefined);
  const dm = target.conversationKey.startsWith("dm:");
  const key = JSON.stringify(target);
  const reload = useCallback(async () => {
    reading.current?.abort();
    if (!dm) return setList(undefined);
    const abort = new AbortController();
    reading.current = abort;
    try {
      const next = await peer.call("changes.reviewers", JSON.parse(key) as ChangesTarget, {
        signal: abort.signal,
        timeoutMs: 15_000,
      });
      if (!abort.signal.aborted) setList(next);
    } catch {
      // The picker is optional; without it the pane asks the chat's Bot as before.
      if (!abort.signal.aborted) setList(undefined);
    }
  }, [peer, key, dm]);
  useEffect(() => {
    void reload();
    return () => reading.current?.abort();
  }, [reload]);
  return { list, reload };
}
export type Reviewers = ReturnType<typeof useReviewers>;
