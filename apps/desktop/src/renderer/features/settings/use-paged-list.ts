import { useCallback, useEffect, useRef, useState } from "react";

/** Latest request wins across filter/peer changes; same-page calls cannot race. */
export function usePagedList<T extends { id: string }>(
  fetchPage: (before?: string) => Promise<T[]>,
) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const state = useRef({
    items: [] as T[],
    locked: false,
    version: 0,
    before: undefined as string | undefined,
  });
  const load = useCallback(
    async (more = false) => {
      const current = state.current;
      if (current.locked) return;
      current.locked = true;
      const version = current.version;
      const before = more ? current.before : undefined;
      setLoading(true);
      setError(false);
      try {
        const page = await fetchPage(before);
        if (version !== state.current.version) return;
        const existing = more ? state.current.items : [];
        const ids = new Set(existing.map((item) => item.id));
        const next = [...existing, ...page.filter((item) => !ids.has(item.id))];
        state.current.items = next;
        state.current.before = page.at(-1)?.id;
        setItems(next);
        setHasMore(page.length === 50);
      } catch {
        if (version === state.current.version) setError(true);
      } finally {
        if (version === state.current.version) {
          state.current.locked = false;
          setLoading(false);
        }
      }
    },
    [fetchPage],
  );
  useEffect(() => {
    state.current = {
      items: [],
      locked: false,
      version: state.current.version + 1,
      before: undefined,
    };
    setItems([]);
    setHasMore(false);
    void load();
    return () => {
      state.current.version++;
    };
  }, [load]);
  return { items, loading, error, hasMore, load };
}
