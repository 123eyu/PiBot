import { type Peer, useRpc, useWorkspace } from "@pibot/renderer-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  readTimelineBots,
  readTimelineRoutines,
  type TimelineBot,
  type TimelineRoutine,
} from "./timeline-metadata.ts";
import type { TimelinePoint } from "./timeline-points.ts";

interface Cache {
  peer: Peer | null;
  scope: string;
  bots: Map<string, TimelineBot | null>;
  routines: Map<string, TimelineRoutine | null>;
}

export function useTimelineMetadata(points: readonly TimelinePoint[], scope: string) {
  const { peer } = useRpc();
  const workspace = useWorkspace();
  const source = useRef<{ peer: typeof peer; blocked?: typeof workspace.bots }>({ peer });
  if (source.current.peer !== peer) source.current = { peer, blocked: workspace.bots };
  const trusted = workspace.bots !== source.current.blocked;
  const botKey = JSON.stringify([...new Set(points.map((p) => p.botId))].sort());
  const taskKey = JSON.stringify([...new Set(points.flatMap((p) => p.routineId ?? []))].sort());
  const known = useMemo(
    () => new Map(trusted ? workspace.bots.map((bot) => [bot.id, bot]) : []),
    [workspace.bots, trusted],
  );
  const missingBotKey = JSON.stringify(
    [...new Set(points.map((p) => p.botId))].filter((id) => !known.has(id)).sort(),
  );
  const knownRef = useRef(known);
  knownRef.current = known;
  const cache = useRef<Cache>({ peer: null, scope: "", bots: new Map(), routines: new Map() });
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Cache & { revision: number }>();
  const readOwner = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(() => {
    readOwner.current?.abort();
    cache.current.bots.clear();
    cache.current.routines.clear();
    setRevision((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!peer) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      // Stop a pre-event read immediately; its old attributes cannot repopulate the invalidated cache.
      readOwner.current?.abort();
      timer ??= setTimeout(() => {
        timer = undefined;
        setRevision((n) => n + 1);
      }, 250);
    };
    const off = [
      peer.on("bots.changed", ({ botId }) => {
        cache.current.bots.delete(botId);
        changed();
      }),
      peer.on("routines.changed", ({ id }) => {
        if (id) cache.current.routines.delete(id);
        else cache.current.routines.clear();
        changed();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const unsubscribe of off) unsubscribe();
    };
  }, [peer]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Stable identity keys avoid re-reading on each clock/page render; revision explicitly invalidates reads.
  useEffect(() => {
    if (cache.current.peer !== peer || cache.current.scope !== scope)
      cache.current = { peer, scope, bots: new Map(), routines: new Map() };
    const current = cache.current;
    const owner = new AbortController();
    readOwner.current = owner;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]);
    const botIds: string[] = JSON.parse(botKey);
    const taskIds: string[] = JSON.parse(taskKey);
    // Retain recently loaded names through planned-page refresh, with a finite per-day cache.
    for (const [map, ids] of [
      [current.bots, botIds],
      [current.routines, taskIds],
    ] as const) {
      if (map.size <= 4096) continue;
      const visible = new Set(ids);
      for (const id of map.keys()) if (!visible.has(id)) map.delete(id);
    }
    const publish = () => {
      if (!owner.signal.aborted)
        setResult({
          ...current,
          revision,
          bots: new Map(current.bots),
          routines: new Map(current.routines),
        });
    };
    publish();
    if (!peer) return () => owner.abort();
    const bots = botIds.filter((id) => !knownRef.current.has(id) && !current.bots.has(id));
    const tasks = taskIds.filter((id) => !current.routines.has(id));
    const loadBots = async () => {
      try {
        const values = await readTimelineBots(peer, bots, signal);
        if (!signal.aborted) for (const [id, value] of values) current.bots.set(id, value);
      } catch {
        // A catalog failure affects labels only, never power/run/plan pagination.
        if (!owner.signal.aborted) for (const id of bots) current.bots.set(id, null);
      }
      publish();
    };
    const loadTasks = async () => {
      const values = await readTimelineRoutines(peer, tasks, signal);
      if (!owner.signal.aborted) for (const [id, value] of values) current.routines.set(id, value);
      publish();
    };
    void Promise.all([loadBots(), loadTasks()]);
    return () => owner.abort();
  }, [peer, scope, botKey, taskKey, missingBotKey, revision]);
  const valid = result?.peer === peer && result.scope === scope && result.revision === revision;
  const bot = (id: string) => known.get(id) ?? (valid ? result.bots.get(id) : undefined);
  const routine = (id: string) => (valid ? result.routines.get(id) : undefined);
  const unavailable = points.some(
    (p) => bot(p.botId) === null || (p.routineId && routine(p.routineId) === null),
  );
  return { bot, routine, unavailable, refresh };
}
