import type { MethodParams } from "@pibot/protocol";
import type { OfflineDeviceView } from "@pibot/remote-contract";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

/** One phone's offline models and Bots on the computer's Devices page. */
export function useOfflineModels(deviceId: string) {
  const { peer } = useRpc();
  const [view, setView] = useState<OfflineDeviceView>();
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const lifetime = useRef<AbortController>(undefined);
  const read = useRef<AbortController>(undefined);
  const load = useCallback(async () => {
    const owner = lifetime.current;
    if (!peer || !owner || owner.signal.aborted) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    try {
      const next = await peer.call(
        "remote.offline.get",
        { deviceId },
        {
          signal: AbortSignal.any([controller.signal, owner.signal, AbortSignal.timeout(15_000)]),
        },
      );
      if (read.current !== controller) return;
      setView(next);
      setFailed(false);
    } catch {
      if (read.current === controller && !owner.signal.aborted) setFailed(true);
    }
  }, [peer, deviceId]);
  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    setView(undefined);
    void load();
    return () => owner.abort();
  }, [load]);
  // A Bot's model or a provider key changed: what the phone can use may have changed with it.
  useRpcEvent("bots.changed", () => void load());
  useRpcEvent("providers.changed", () => void load());
  // One write at a time; the answer is the new view, so nothing is guessed on the page.
  const write = async (params: MethodParams["remote.offline.set"]) => {
    const owner = lifetime.current;
    if (!peer || !owner || saving) return false;
    setSaving(true);
    setSaveFailed(false);
    try {
      const next = await peer.call("remote.offline.set", params, { signal: owner.signal });
      if (!owner.signal.aborted) setView(next);
      return true;
    } catch {
      if (!owner.signal.aborted) {
        setSaveFailed(true);
        void load();
      }
      return false;
    } finally {
      if (!owner.signal.aborted) setSaving(false);
    }
  };
  return {
    view,
    failed,
    saving,
    saveFailed,
    reload: load,
    setBot: (botId: string, offline: boolean) => write({ deviceId, bot: { botId, offline } }),
  };
}
