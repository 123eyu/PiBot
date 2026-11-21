import { canonicalImageModelId, type ImageMode, type ImageModelInfo } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

export function useImageCatalog(
  mode: ImageMode | undefined,
  enabled = true,
  selected?: { provider: string; id: string },
) {
  const { peer } = useRpc();
  const selectedProvider = selected?.provider;
  const selectedId = selected?.id;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({
    models: [] as ImageModelInfo[],
    loading: false,
    error: false,
    hasMore: false,
  });
  const generation = useRef(0);
  const cursor = useRef<string | undefined>(undefined);
  const locked = useRef(false);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const read = useCallback(
    async (append: boolean, version: number) => {
      if (!peer || locked.current) return;
      locked.current = true;
      setState((current) => ({ ...current, loading: true, error: false }));
      try {
        const models = await peer.call(
          "models.images",
          { availableOnly: true, mode, limit: 200, before: append ? cursor.current : undefined },
          { timeoutMs: 30_000 },
        );
        const chosen =
          selectedProvider &&
          selectedId &&
          !models.some(
            (model) =>
              model.provider === selectedProvider &&
              model.id === canonicalImageModelId(selectedProvider, selectedId),
          )
            ? await peer.call("models.images", {
                availableOnly: true,
                selected: { provider: selectedProvider, id: selectedId },
                limit: 1,
              })
            : [];
        if (version !== generation.current) return;
        const last = models.at(-1);
        cursor.current = last ? JSON.stringify([last.provider, last.id]) : undefined;
        setState((current) => ({
          models: [
            ...new Map(
              [...(append ? current.models : []), ...models, ...chosen].map((model) => [
                JSON.stringify([model.provider, model.id]),
                model,
              ]),
            ).values(),
          ],
          loading: false,
          error: false,
          hasMore: models.length === 200,
        }));
      } catch {
        if (version === generation.current)
          setState((current) => ({ ...current, loading: false, error: true }));
      } finally {
        if (version === generation.current) locked.current = false;
      }
    },
    [peer, mode, selectedProvider, selectedId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry replaces the read lifetime.
  useEffect(() => {
    const version = ++generation.current;
    cursor.current = undefined;
    locked.current = false;
    setState({ models: [], loading: !!peer && enabled, error: false, hasMore: false });
    if (enabled) void read(false, version);
    const off = enabled ? peer?.on("providers.changed", reload) : undefined;
    return () => {
      generation.current++;
      off?.();
    };
  }, [peer, enabled, read, reload, revision]);
  return {
    ...state,
    reload,
    more: () => {
      if (state.hasMore) void read(true, generation.current);
    },
  };
}
