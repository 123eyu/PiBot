import type { ScopedGoogleCompat } from "@pibot/browser-contract/full";
import type { Peer } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

/** Scope identity is checked on replies and events, so a group never adopts a member's setting. */
export function useGoogleCompat(peer: Peer | null | undefined, botId?: string, groupId?: string) {
  const [state, setState] = useState<ScopedGoogleCompat | null>(null);
  const [error, setError] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const epoch = useRef(0),
    locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the user-requested retry for this scope.
  useEffect(() => {
    const controller = new AbortController(),
      version = ++epoch.current;
    let observed = 0;
    const matches = (value: ScopedGoogleCompat) =>
      groupId ? value.groupId === groupId && !value.botId : !value.groupId && value.botId === botId;
    setState(null);
    setError(false);
    setLoading(true);
    setBusy(false);
    locked.current = false;
    if (!peer || (!botId && !groupId)) {
      setLoading(false);
      return () => controller.abort();
    }
    const load = async () => {
      const request = observed;
      setLoading(true);
      setError(false);
      try {
        const value = await peer.call(
          "browser.googleCompat.get",
          groupId ? { groupId } : { botId: botId as string },
          { signal: controller.signal, timeoutMs: 10000 },
        );
        if (!matches(value)) throw new Error("Mismatched browser permission scope");
        if (!controller.signal.aborted && request === observed) setState(value);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    const offs = [
      peer.on("browser.googleCompat.changed", (value) => {
        if (matches(value)) {
          observed++;
          setState(value);
          setError(false);
        }
      }),
      peer.on("brain.status", (event) => {
        if (event.state === "ready") void load();
      }),
    ];
    void load();
    return () => {
      controller.abort();
      if (epoch.current === version) epoch.current++;
      for (const off of offs) off();
    };
  }, [peer, botId, groupId, revision]);
  const set = useCallback(
    async (enabled: boolean) => {
      if (!peer || (!botId && !groupId) || locked.current)
        throw new Error("Browser settings unavailable");
      const version = epoch.current;
      locked.current = true;
      setBusy(true);
      setError(false);
      try {
        const value = await peer.call(
          "browser.googleCompat.set",
          groupId ? { groupId, enabled } : { botId: botId as string, enabled },
          { timeoutMs: 20000 },
        );
        if (
          groupId
            ? value.groupId !== groupId || !!value.botId
            : value.botId !== botId || !!value.groupId
        )
          throw new Error("Mismatched browser permission scope");
        if (epoch.current === version) setState(value);
      } finally {
        if (epoch.current === version) {
          locked.current = false;
          setBusy(false);
        }
      }
    },
    [peer, botId, groupId],
  );
  return { state, set, error, loading, busy, refresh: () => refresh((value) => value + 1) };
}
