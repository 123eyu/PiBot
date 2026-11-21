import type { MethodResults, Routine } from "@pibot/protocol";
import { type Peer, waitRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useMemo } from "react";
import { useRemote, useRoutineRefresh } from "../shell/remote.ts";

export type RoutineRowState = MethodResults["routines.rows"]["rows"][number];

export function useRoutineRows(routines: Routine[], botId?: string) {
  const key = routines
    .map((r) => r.id)
    .sort()
    .join(",");
  const ids = useMemo(() => (key ? key.split(",") : []), [key]);
  const load = useCallback(
    async (peer: Peer, signal: AbortSignal) => {
      const rows = new Map<string, RoutineRowState>();
      let pausedUntil: string | null = null;
      let at: string | undefined;
      // Only loaded, visible IDs are queried; serial chunks bound concurrent RPCs as the list grows.
      for (let offset = 0; offset < ids.length; offset += 200) {
        const batch = ids.slice(offset, offset + 200);
        const result = await waitRpc(() => peer.call("routines.rows", { ids: batch }), signal);
        const expected = new Set(batch);
        for (const row of result.rows) {
          if (!expected.has(row.routineId) || rows.has(row.routineId))
            throw new Error("Routine row ownership mismatch");
          rows.set(row.routineId, row);
        }
        if (at && pausedUntil !== result.pausedUntil) throw new Error("Routine pause changed");
        at = result.at;
        pausedUntil = result.pausedUntil;
      }
      return { rows, pausedUntil, at };
    },
    [ids],
  );
  const remote = useRemote(load);
  useRoutineRefresh(remote.refresh, botId, { routineIds: ids });
  useEffect(() => {
    if (!ids.length) return;
    const timer = setInterval(remote.refresh, 30_000);
    return () => clearInterval(timer);
  }, [ids, remote.refresh]);
  return remote;
}
