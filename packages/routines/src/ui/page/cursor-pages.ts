import { type Peer, useRpc, waitRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { routineError } from "../shell/remote.ts";

export interface CursorBatch<T, C, M> {
  items: T[];
  cursor?: C;
  meta: M;
}

function appendBatch<T, C, M>(
  old: CursorBatch<T, C, M>,
  next: CursorBatch<T, C, M>,
  key: (item: T) => string,
  sameContext: (old: M, next: M) => boolean,
) {
  if (!sameContext(old.meta, next.meta)) throw new Error("Timeline context changed");
  if (next.cursor !== undefined && JSON.stringify(next.cursor) === JSON.stringify(old.cursor))
    throw new Error("Timeline cursor did not advance");
  const items = new Map(old.items.map((item) => [key(item), item]));
  for (const item of next.items) items.set(key(item), item);
  return { ...next, items: [...items.values()] };
}

export function useCursorPages<T, C, M>(
  load: (peer: Peer, cursor: C | undefined) => Promise<CursorBatch<T, C, M>>,
  key: (item: T) => string,
  sameContext: (old: M, next: M) => boolean,
  options?: { refreshLoadedPages?: boolean },
) {
  const { peer } = useRpc();
  const [result, setResult] = useState<{
    peer: Peer;
    load: typeof load;
    batch: CursorBatch<T, C, M>;
  }>();
  const batch = result?.peer === peer && result.load === load ? result.batch : undefined;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof routineError>>();
  const [revision, setRevision] = useState(0);
  const owner = useRef(new AbortController());
  const lock = useRef(false);
  const range = useRef<{ peer: Peer; load: typeof load; pages: number } | undefined>(undefined);
  const refreshLoadedPages = options?.refreshLoadedPages ?? false;
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh invalidates the entire local pagination lifetime.
  useEffect(() => {
    const current = new AbortController();
    owner.current = current;
    lock.current = true;
    const pages =
      refreshLoadedPages && range.current?.peer === peer && range.current.load === load
        ? range.current.pages
        : 1;
    range.current = peer ? { peer, load, pages } : undefined;
    // Keep only the requested depth. Old points and power completeness are never authoritative.
    setResult(undefined);
    setLoading(true);
    setError(undefined);
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(30_000)]);
    void waitRpc(async () => {
      if (!peer) throw new Error("Disconnected");
      let batch = await waitRpc(() => load(peer, undefined), signal);
      let read = 1;
      // Follow fresh cursors serially, stopping at the user's depth or the new end of the list.
      while (read < pages && batch.cursor !== undefined) {
        const next = await waitRpc(() => load(peer, batch.cursor), signal);
        batch = appendBatch(batch, next, key, sameContext);
        read++;
      }
      return { batch, pages: read };
    }, signal)
      .then(({ batch, pages }) => {
        if (peer && !current.signal.aborted) {
          range.current = { peer, load, pages };
          setResult({ peer, load, batch });
        }
      })
      .catch((e: unknown) => {
        if (!current.signal.aborted) setError(peer ? routineError(e) : "routines.unavailable");
      })
      .finally(() => {
        if (!current.signal.aborted) {
          lock.current = false;
          setLoading(false);
        }
      });
    return () => current.abort();
  }, [peer, load, key, sameContext, refreshLoadedPages, revision]);
  async function next() {
    if (!peer || lock.current || batch?.cursor === undefined) return;
    const current = owner.current;
    lock.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const next = await waitRpc(
        () => load(peer, batch.cursor),
        AbortSignal.any([current.signal, AbortSignal.timeout(30_000)]),
      );
      if (current.signal.aborted) return;
      const merged = appendBatch(batch, next, key, sameContext);
      range.current = { peer, load, pages: (range.current?.pages ?? 1) + 1 };
      setResult((old) => {
        if (old?.peer !== peer || old.load !== load) return old;
        return {
          peer,
          load,
          batch: merged,
        };
      });
    } catch (e) {
      if (!current.signal.aborted) setError(routineError(e));
    } finally {
      if (!current.signal.aborted) {
        lock.current = false;
        setLoading(false);
      }
    }
  }
  return { batch, loading, error, more: batch?.cursor !== undefined, next, refresh };
}
