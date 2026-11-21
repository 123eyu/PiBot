import type { MethodParams, Permissions } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

export type PermissionUpdate = Omit<MethodParams["permissions.set"], "botId" | "groupId">;

export function usePermissions(botId?: string, groupId?: string) {
  const { peer } = useRpc();
  const [data, setData] = useState<Permissions>();
  const [global, setGlobal] = useState<Permissions>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const epoch = useRef(0);
  const revision = useRef(0);
  const reads = useRef(0);
  // A second click while the first save is in flight used to be dropped. Queue it instead, and
  // identify each save so a scope change can clear the busy state without an old completion
  // turning it off for a newer save.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const activeSaves = useRef(new Set<number>());
  const nextSaveId = useRef(0);
  const refresh = useCallback(async () => {
    if (!peer) return;
    const version = epoch.current;
    const requested = revision.current;
    const requestId = ++reads.current;
    setError(false);
    setRefreshing(true);
    try {
      const [globalResult, result] = await Promise.all([
        peer.call("permissions.get", undefined),
        botId || groupId ? peer.call("permissions.get", { botId, groupId }) : undefined,
      ]);
      if (globalResult.botId !== undefined || globalResult.groupId !== undefined)
        throw new Error("Mismatched global permissions");
      const scoped = result ?? globalResult;
      if (
        (botId || groupId) &&
        (scoped.botId !== botId ||
          scoped.groupId !== groupId ||
          !scoped.overrides ||
          !scoped.effective)
      )
        throw new Error("Missing scoped permissions");
      if (
        version === epoch.current &&
        requestId === reads.current &&
        requested === revision.current
      ) {
        setGlobal(globalResult);
        setData(scoped);
      }
    } catch {
      if (version === epoch.current && requestId === reads.current) setError(true);
    } finally {
      if (version === epoch.current && requestId === reads.current) setRefreshing(false);
    }
  }, [peer, botId, groupId]);
  useEffect(() => {
    epoch.current++;
    setData(undefined);
    setGlobal(undefined);
    setBusy(false);
    setError(false);
    activeSaves.current.clear();
    // Old in-flight saves still finish, but queued ones see the epoch change and do not run.
    queue.current = Promise.resolve();
    const unsubscribe = peer?.on("permissions.changed", (result) => {
      if (
        (result.botId || result.groupId) &&
        (result.botId !== botId || result.groupId !== groupId)
      )
        return;
      revision.current++;
      // Global changes refresh followed defaults; independently configured fields remain unchanged.
      void refresh();
    });
    void refresh();
    return () => {
      epoch.current++;
      unsubscribe?.();
    };
  }, [peer, botId, groupId, refresh]);
  const save = (patch: PermissionUpdate): Promise<boolean> => {
    if (!peer) return Promise.resolve(false);
    const id = ++nextSaveId.current;
    const version = epoch.current;
    activeSaves.current.add(id);
    setBusy(true);
    const run = queue.current.then(async () => {
      if (version !== epoch.current) return false;
      reads.current++;
      setRefreshing(false);
      setError(false);
      const requested = revision.current;
      try {
        const result = await peer.call("permissions.set", {
          ...patch,
          ...(botId ? { botId } : {}),
          ...(groupId ? { groupId } : {}),
        });
        if (version !== epoch.current) return false;
        if (
          result.botId !== botId ||
          result.groupId !== groupId ||
          ((botId || groupId) && (!result.overrides || !result.effective))
        )
          throw new Error("Mismatched permission scope");
        if (requested === revision.current) {
          setData(result);
          if (!botId && !groupId) setGlobal(result);
        }
        return true;
      } catch {
        if (version === epoch.current) {
          await refresh();
          if (version === epoch.current) setError(true);
        }
        return false;
      }
    });
    queue.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      activeSaves.current.delete(id);
      setBusy(activeSaves.current.size > 0);
    });
  };
  return { data, global, error, busy, refreshing, save, refresh, connected: !!peer };
}
