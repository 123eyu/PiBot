import { type Peer, selectedImageModel, useRpc, waitRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";
import { useRemote } from "../shell/remote.ts";

async function loadRoutineBot(peer: Peer, botId: string, signal: AbortSignal) {
  const { bot } = await peer.call("bots.profile", { botId }, { signal });
  signal.throwIfAborted();
  if (bot.id !== botId) throw new Error("Routine Bot ownership mismatch");
  const model =
    bot.category === "image" && bot.modelProvider && bot.modelId
      ? await selectedImageModel(peer, { provider: bot.modelProvider, id: bot.modelId }, signal)
      : undefined;
  return {
    ...bot,
    imageScheduleAvailable: model?.modes.includes("text-to-image") ?? false,
    // The catalog's canonical id, the same one a paid_image grant or pre-approval names.
    imageModel: model ? { provider: model.provider, id: model.id } : undefined,
  };
}
export type RoutineBot = Awaited<ReturnType<typeof loadRoutineBot>>;

// Read by identity, so a preselected Bot outside the first list page is also checked.
export function useRoutineBot(botId: string | undefined) {
  const { peer } = useRpc();
  const load = useCallback(
    async (peer: Peer, signal: AbortSignal) => (botId ? loadRoutineBot(peer, botId, signal) : null),
    [botId],
  );
  const remote = useRemote(load);
  useEffect(() => {
    const off = peer?.on("bots.changed", (event) => {
      if (event.botId === botId) remote.refresh();
    });
    const providers = peer?.on("providers.changed", remote.refresh);
    return () => {
      off?.();
      providers?.();
    };
  }, [peer, botId, remote.refresh]);
  const unsupported = remote.value?.category === "image" && !remote.value.imageScheduleAvailable;
  return { ...remote, unsupported, blocked: !!botId && (!remote.value || unsupported) };
}

const noBots = new Map<string, RoutineBot>();
/**
 * One read per distinct Bot for a whole list: rows of the same Bot used to issue their own
 * profile and model reads, which filled the GUI request slots when the page opened. A refresh
 * keeps the previous values on screen until the new ones arrive.
 */
export function useRoutineBots(botIds: readonly string[]) {
  const { peer } = useRpc();
  const key = [...new Set(botIds)].sort().join(",");
  const [state, setState] = useState<{ peer: Peer; values: Map<string, RoutineBot> }>();
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly requests a fresh read
  useEffect(() => {
    if (!peer || !key) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    const ids = key.split(",");
    void Promise.allSettled(
      ids.map((id) => waitRpc(() => loadRoutineBot(peer, id, signal), signal)),
    ).then((results) => {
      if (abort.signal.aborted) return;
      setState((previous) => {
        const values = new Map(previous?.peer === peer ? previous.values : []);
        results.forEach((result, index) => {
          const id = ids[index];
          if (!id) return;
          // A failed read drops the stale value: the row then shows the unknown state.
          if (result.status === "fulfilled") values.set(id, result.value);
          else values.delete(id);
        });
        return { peer, values };
      });
    });
    return () => abort.abort();
  }, [peer, key, revision]);
  useEffect(() => {
    if (!peer || !key) return;
    const ids = new Set(key.split(","));
    const refresh = () => setRevision((value) => value + 1);
    const off = [
      peer.on("bots.changed", (event) => {
        if (ids.has(event.botId)) refresh();
      }),
      peer.on("providers.changed", refresh),
    ];
    return () => {
      for (const unsubscribe of off) unsubscribe();
    };
  }, [peer, key]);
  return state?.peer === peer ? state.values : noBots;
}
