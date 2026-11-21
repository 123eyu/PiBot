import { type Peer, useRpc, waitRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { routineError } from "../shell/remote.ts";

// Cursors are last IDs, never page numbers or a claim that one page is the whole list.
export function usePages<T extends { id: string }>(
  load: (peer: Peer, before?: string, signal?: AbortSignal) => Promise<T[]>,
  limit = 50,
) {
  const { peer } = useRpc();
  const [page, setPage] = useState<{ peer: Peer; load: typeof load; rows: T[] }>();
  const rows = page?.peer === peer && page.load === load ? page.rows : [];
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof routineError>>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const owner = useRef(new AbortController());
  const lock = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh replaces the page and cancels its old local lifetime.
  useEffect(() => {
    const current = new AbortController();
    owner.current = current;
    lock.current = true;
    // Same-owner refresh keeps mounted rows; a new peer or filter cannot display old data.
    setMore(false);
    setLoading(true);
    setError(undefined);
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(30_000)]);
    void waitRpc(() => {
      if (!peer) throw new Error("Disconnected");
      return load(peer, undefined, signal);
    }, signal)
      .then((page) => {
        if (!current.signal.aborted) {
          if (peer) setPage({ peer, load, rows: page });
          setMore(page.length === limit);
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
  }, [peer, load, limit, revision]);
  async function next() {
    if (!peer || lock.current || !more) return;
    const current = owner.current;
    lock.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(30_000)]);
      const page = await waitRpc(() => load(peer, rows.at(-1)?.id, signal), signal);
      if (current.signal.aborted) return;
      setPage((old) => {
        const rows = old?.peer === peer && old.load === load ? old.rows : [];
        const ids = new Set(rows.map((r) => r.id));
        return { peer, load, rows: [...rows, ...page.filter((r) => !ids.has(r.id))] };
      });
      setMore(page.length === limit && page.at(-1)?.id !== rows.at(-1)?.id);
    } catch (e) {
      if (!current.signal.aborted) setError(routineError(e));
    } finally {
      if (!current.signal.aborted) {
        lock.current = false;
        setLoading(false);
      }
    }
  }
  return { rows, loading, error, more, next, refresh };
}
