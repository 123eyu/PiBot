import type { MethodResults, RoutineHistoryView } from "@pibot/protocol";
import type { Peer } from "@pibot/renderer-kit";
import { routineRunTarget } from "@pibot/routines/ui";

export function locateRoutineRun(peer: Peer, run: RoutineHistoryView, signal: AbortSignal) {
  if (!run.triggerMessageId || run.taskDeleted) throw new Error("Run target unavailable");
  // Reject a deletion after the history snapshot without changing other callers' topic rules.
  const currentPeer: Peer = {
    ...peer,
    call: async (method, params, options) => {
      const result = await peer.call(method, params, options);
      if (method === "routines.get" && (result as MethodResults["routines.get"]).deletedAt)
        throw new Error("Run task deleted");
      return result;
    },
  };
  return routineRunTarget(currentPeer, run, signal);
}
