import type { ComputerBlocklistEntry } from "@pibot/computer-use-contract/full";
import { useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";
import { computerErrorKey } from "../presentation.ts";

/** Generic one-shot read with retry; each caller owns its own copy (lists are small, reads rare). */
function useRead<T>(read: (() => Promise<T>) | undefined) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit reread trigger
  useEffect(() => {
    if (!read) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    read()
      .then((result) => {
        if (active) setData(result);
      })
      .catch((e: unknown) => {
        if (active) setError(computerErrorKey(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [read, revision]);
  return { data, setData, error, loading, reload };
}

/** Installed apps come from the host scan (about 3 s on macOS), read on demand only. */
export function useInstalledApps(enabled = true) {
  const { peer } = useRpc();
  const read = useCallback(
    () =>
      peer
        ? peer.call("computer.installedApps", undefined)
        : Promise.reject(new Error("Disconnected")),
    [peer],
  );
  return useRead(peer && enabled ? read : undefined);
}

export function useBlocklist() {
  const { peer } = useRpc();
  const read = useCallback(
    () =>
      peer
        ? peer.call("computer.blocklist.list", undefined)
        : Promise.reject(new Error("Disconnected")),
    [peer],
  );
  return useRead(peer ? read : undefined);
}

/** Active entries only: removed suggestions stay listed by brain but no longer block. */
export const isBlocking = (entry: ComputerBlocklistEntry) => !entry.removed;
