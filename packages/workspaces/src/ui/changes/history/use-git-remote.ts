import type { TranslationKey } from "@pibot/i18n";
import { useRpc } from "@pibot/renderer-kit";
import {
  type ChangesStatus,
  type ChangesTarget,
  type MethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/workspaces-contract/full";
import { useEffect, useRef, useState } from "react";
import { changesErrorKey } from "../model.ts";
export type RemoteSnapshot = MethodResults["changes.remotes"];
export type RemoteAction = "push" | "pull";
export interface RemoteConfirmation {
  action: RemoteAction;
  remote: string;
  snapshot: RemoteSnapshot;
}
const remoteErrors = [
  "changes_remote_unavailable",
  "changes_remote_unsupported",
  "changes_remote_no_upstream",
  "changes_remote_dirty",
  "changes_remote_auth",
  "changes_remote_rejected",
  "changes_remote_diverged",
  "changes_remote_network",
  "changes_remote_policy",
] as const;
export function remoteErrorKey(error: unknown): TranslationKey {
  if (
    error instanceof RpcError &&
    (error.code === RpcErrorCodes.timeout || error.code === RpcErrorCodes.closed)
  )
    return "changes.remote.uncertain";
  const code = remoteErrors.find((value) => error instanceof Error && error.message === value);
  return code ? `changes.error.${code}` : changesErrorKey(error);
}
/** Reads may refresh automatically; only confirm() can issue a network mutation. */
export function useGitRemote(target: ChangesTarget, status: ChangesStatus, refresh?: () => void) {
  const { peer } = useRpc();
  const key = JSON.stringify(target),
    lifetime = useRef(new AbortController()),
    lock = useRef(false),
    generation = useRef(0);
  const [data, setData] = useState<RemoteSnapshot>(),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<TranslationKey>(),
    [done, setDone] = useState<RemoteAction>(),
    [dialog, setDialog] = useState<RemoteConfirmation>();
  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    return () => owner.abort();
  }, []);
  const read = async (signal: AbortSignal) => {
    if (!peer) return undefined;
    const value = await peer.call("changes.remotes", JSON.parse(key) as ChangesTarget, {
      signal,
      timeoutMs: 30000,
    });
    signal.throwIfAborted();
    return value;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh status includes changed Git config/remotes; mutations still require a click and confirmation
  useEffect(() => {
    const owner = new AbortController(),
      current = ++generation.current;
    setLoading(true);
    void read(owner.signal)
      .then((value) => {
        if (generation.current === current && !owner.signal.aborted) setData(value);
      })
      .catch((failure) => {
        if (!owner.signal.aborted && generation.current === current)
          setError(remoteErrorKey(failure));
      })
      .finally(() => {
        if (!owner.signal.aborted && generation.current === current) setLoading(false);
      });
    return () => owner.abort();
  }, [peer, key, status]);
  const reload = async () => {
    if (lock.current || !peer) return undefined;
    lock.current = true;
    setLoading(true);
    setError(undefined);
    setDone(undefined);
    try {
      const value = await read(lifetime.current.signal);
      if (!lifetime.current.signal.aborted) setData(value);
      return value;
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(remoteErrorKey(failure));
      return undefined;
    } finally {
      lock.current = false;
      if (!lifetime.current.signal.aborted) setLoading(false);
    }
  };
  return {
    data,
    loading,
    busy,
    error,
    done,
    dialog,
    setDialog,
    reload,
    open: async (action: RemoteAction) => {
      const snapshot = await reload();
      if (snapshot && !lifetime.current.signal.aborted)
        setDialog({
          action,
          remote: snapshot.remotes.length === 1 ? (snapshot.remotes[0]?.name ?? "") : "",
          snapshot,
        });
    },
    close: () => {
      if (!lock.current) {
        setDialog(undefined);
        setError(undefined);
      }
    },
    confirm: async () => {
      if (!peer || !dialog || lock.current || !dialog.snapshot.head || !dialog.snapshot.branch)
        return;
      const { snapshot, remote, action } = dialog;
      const { head, branch } = snapshot;
      if (!head || !branch) return;
      const remoteBranch =
        snapshot.upstream?.remote === remote ? snapshot.upstream.branch : snapshot.branch;
      if (!remote || !remoteBranch) return;
      lock.current = true;
      setBusy(true);
      setError(undefined);
      setDone(undefined);
      try {
        await peer.call(
          "changes.sync",
          {
            ...(JSON.parse(key) as ChangesTarget),
            action,
            remote,
            remoteBranch,
            head,
            branch,
          },
          { signal: lifetime.current.signal, timeoutMs: 200000 },
        );
        if (!lifetime.current.signal.aborted) {
          setDialog(undefined);
          setDone(action);
        }
      } catch (failure) {
        if (!lifetime.current.signal.aborted) {
          setError(remoteErrorKey(failure));
          setDialog(undefined);
        }
      } finally {
        lock.current = false;
        if (!lifetime.current.signal.aborted) {
          setBusy(false);
          refresh?.();
        }
      }
    },
  };
}
export type GitRemoteState = ReturnType<typeof useGitRemote>;
