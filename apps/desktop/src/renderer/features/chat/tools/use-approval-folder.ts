import type { ChatPeer } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import { folderError } from "@pibot/renderer-kit";
import { type RefObject, useEffect, useRef, useState } from "react";

export function useApprovalFolder(
  peer: ChatPeer | null,
  id: string,
  pending: boolean,
  locked: RefObject<boolean>,
  refresh: () => Promise<void>,
) {
  const lifetime = useRef<AbortController | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a card, peer or status change retires its request lifetime.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPicking(false);
    setError(undefined);
    return () => {
      controller.abort();
      locked.current = false;
    };
  }, [peer, id, pending, locked]);
  const add = async () => {
    const signal = lifetime.current?.signal;
    if (!peer || !pending || !signal || signal.aborted || locked.current) return;
    locked.current = true;
    setPicking(true);
    setError(undefined);
    try {
      const result = await peer.call(
        "approvals.addWritableFolder",
        { id },
        { signal, timeoutMs: 680_000 },
      );
      if (!signal.aborted && result.added) await refresh();
    } catch (cause) {
      if (!signal.aborted) {
        setError(folderError(cause));
        // A lost reply may have committed the association; inspect rather than repeat the mutation.
        try {
          await refresh();
        } catch {
          if (!signal.aborted) setError("folders.uncertain");
        }
      }
    } finally {
      if (!signal.aborted) {
        locked.current = false;
        setPicking(false);
      }
    }
  };
  return { add, picking, error };
}
