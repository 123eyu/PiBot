import type { ChatPeer } from "@pibot/client-core";
import type { ExecutionMode, GroupExecutionSettings } from "@pibot/protocol";
import { useEffect, useRef, useState } from "react";

export function useGroupExecutionMode(peer: ChatPeer, groupId: string) {
  const [state, setState] = useState<{
    groupId: string;
    settings?: GroupExecutionSettings;
    error: boolean;
    busy: boolean;
  }>();
  const [revision, retry] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const locked = useRef(false);
  const current = state?.groupId === groupId ? state : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries the current group's shared setting.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    locked.current = false;
    setState((old) => ({
      groupId,
      settings: old?.groupId === groupId ? old.settings : undefined,
      busy: false,
      error: false,
    }));
    const accept = (settings: GroupExecutionSettings) => {
      if (!controller.signal.aborted && settings.groupId === groupId)
        setState((old) => ({
          groupId,
          settings:
            old?.groupId === groupId && old.settings && old.settings.version > settings.version
              ? old.settings
              : settings,
          busy: false,
          error: false,
        }));
    };
    const off = peer.on("groups.execution.changed", accept);
    void peer
      .call("groups.execution.get", { groupId }, { signal: controller.signal, timeoutMs: 10000 })
      .then(accept, () => {
        if (!controller.signal.aborted)
          setState((old) => ({
            groupId,
            settings: old?.groupId === groupId ? old.settings : undefined,
            busy: false,
            error: true,
          }));
      });
    return () => {
      controller.abort();
      off();
    };
  }, [peer, groupId, revision]);
  const change = async (mode: ExecutionMode) => {
    const signal = lifetime.current?.signal,
      settings = current?.settings;
    if (!signal || signal.aborted || !settings || locked.current) return;
    locked.current = true;
    setState((old) => old && { ...old, busy: true, error: false });
    try {
      const next = await peer.call(
        "groups.execution.set",
        { groupId, expectedVersion: settings.version, mode },
        { signal, timeoutMs: 10000 },
      );
      if (!signal.aborted)
        setState((old) => ({
          groupId,
          settings:
            old?.groupId === groupId && old.settings && old.settings.version > next.version
              ? old.settings
              : next,
          busy: false,
          error: false,
        }));
    } catch {
      if (!signal.aborted) setState((old) => old && { ...old, busy: false, error: true });
    } finally {
      if (lifetime.current?.signal === signal) locked.current = false;
    }
  };
  return {
    mode: current?.settings?.mode,
    ready: !!current?.settings && !current.error && !current.busy,
    error: !!current?.error,
    change,
    retry: () => retry((v) => v + 1),
  };
}
