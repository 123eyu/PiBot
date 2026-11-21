import type { ChatPeer } from "@pibot/client-core";
import type { ChangeCommit, ChangesDiff, ChangesTurn } from "@pibot/workspaces-contract/full";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffState } from "./diff/DiffView.tsx";
import { fromChangeFile, fromTurnFile, type ListFile } from "./model.ts";
import { type ChangesTarget, useRunTurn } from "./store.ts";

/** "This turn": a specific run (from a reply card) or the conversation's latest changing run. */
export function usePaneTurn(peer: ChatPeer, target: ChangesTarget, runId: string | undefined) {
  const byRun = useRunTurn(peer, runId);
  const [latest, setLatest] = useState<{
    key?: string;
    data?: ChangesTurn;
    loading: boolean;
    error?: boolean;
  }>({
    loading: !runId,
  });
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([target.conversationKey, target.topicId]);
  useEffect(() => {
    if (runId) return;
    // The brain does not say which conversation a turn belongs to; any recorded turn re-reads.
    return peer.on("changes.changed", (event) => {
      if (event.reason === "turn") setRevision((v) => v + 1);
    });
  }, [peer, runId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads after a turn event
  useEffect(() => {
    if (runId) return;
    const abort = new AbortController();
    const [conversationKey, topicId] = JSON.parse(key) as [string, string | null];
    setLatest((current) =>
      current.key === key
        ? { ...current, error: false, loading: !current.data }
        : { key, loading: true },
    );
    peer
      .call(
        "changes.turn",
        { conversationKey, ...(topicId ? { topicId } : {}) },
        { signal: abort.signal, timeoutMs: 30_000 },
      )
      .then(
        (data) => !abort.signal.aborted && setLatest({ key, data, loading: false }),
        () =>
          !abort.signal.aborted &&
          setLatest((current) => ({ ...current, key, loading: false, error: true })),
      );
    return () => abort.abort();
  }, [peer, key, runId, revision]);
  const retry = useCallback(() => {
    if (runId) byRun.retry();
    else setRevision((value) => value + 1);
  }, [runId, byRun.retry]);
  const state: { data?: ChangesTurn; loading: boolean; error?: boolean } = runId
    ? byRun
    : latest.key === key
      ? latest
      : { loading: true };
  const files = useMemo(() => state.data?.files.map(fromTurnFile) ?? [], [state.data]);
  return { ...state, files, retry, runId: runId ?? state.data?.runId ?? undefined };
}

/** File list of one commit (history scope). */
export function useCommitFiles(peer: ChatPeer, target: ChangesTarget, commit?: ChangeCommit) {
  const [state, setState] = useState<{ files: ListFile[]; loading: boolean; error?: boolean }>({
    files: [],
    loading: false,
  });
  const key = JSON.stringify(target);
  useEffect(() => {
    if (!commit) return;
    const abort = new AbortController();
    setState({ files: [], loading: true });
    peer
      .call(
        "changes.status",
        { ...(JSON.parse(key) as ChangesTarget), commit: commit.oid, limit: 2000 },
        { signal: abort.signal, timeoutMs: 30_000 },
      )
      .then(
        (status) =>
          !abort.signal.aborted &&
          setState({ files: status.files.map(fromChangeFile), loading: false }),
        () => !abort.signal.aborted && setState({ files: [], loading: false, error: true }),
      );
    return () => abort.abort();
  }, [peer, key, commit]);
  return state;
}

export type DiffSource =
  | { scope: "uncommitted"; revision: unknown }
  | { scope: "turn"; runId: string; revision: unknown }
  | { scope: "commit"; commit: string };

/**
 * One file's diff, fetched on demand (diff text is never pushed). A small cache keeps J / K
 * back-and-forth instant; `revision` (the status or turn snapshot) invalidates it.
 */
export function useDiff(
  peer: ChatPeer,
  target: ChangesTarget,
  source: DiffSource,
  file: ListFile | undefined,
) {
  const cache = useRef(new Map<string, ChangesDiff>());
  const revisionRef = useRef<unknown>(undefined);
  const revision = source.scope === "commit" ? source.commit : source.revision;
  if (revisionRef.current !== revision) {
    revisionRef.current = revision;
    cache.current.clear();
  }
  const [state, setState] = useState<DiffState & { key?: string }>({ loading: false });
  const [retry, setRetry] = useState(0);
  const targetKey = JSON.stringify(target);
  const scopeKey =
    source.scope === "commit"
      ? `c:${source.commit}`
      : source.scope === "turn"
        ? `t:${source.runId}`
        : "u";
  const fileKey = file?.diffAvailable && !file.command ? file.key : undefined;
  const cacheKey = fileKey ? `${scopeKey}\0${fileKey}` : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and retry force a re-read
  useEffect(() => {
    if (!fileKey || !cacheKey) return;
    const hit = cache.current.get(cacheKey);
    if (hit) {
      setState({ data: hit, loading: false, key: cacheKey });
      return;
    }
    const abort = new AbortController();
    setState((current) => ({
      loading: true,
      key: cacheKey,
      // Keep the old text while a refreshed snapshot of the same file loads, so it does not flash.
      data: current.key === cacheKey ? current.data : undefined,
    }));
    const base = JSON.parse(targetKey) as ChangesTarget;
    const params =
      source.scope === "commit"
        ? { ...base, path: fileKey, scope: "commit" as const, commit: source.commit }
        : source.scope === "turn"
          ? { ...base, path: fileKey, scope: "turn" as const, runId: source.runId }
          : { ...base, path: fileKey, scope: "uncommitted" as const };
    peer.call("changes.diff", params, { signal: abort.signal, timeoutMs: 30_000 }).then(
      (data) => {
        if (abort.signal.aborted) return;
        cache.current.set(cacheKey, data);
        if (cache.current.size > 40)
          cache.current.delete(cache.current.keys().next().value as string);
        setState({ data, loading: false, key: cacheKey });
      },
      () => !abort.signal.aborted && setState({ loading: false, error: true, key: cacheKey }),
    );
    return () => abort.abort();
  }, [peer, targetKey, cacheKey, revision, retry]);
  return {
    state: state.key === cacheKey ? state : { loading: !!cacheKey },
    retry: () => setRetry((value) => value + 1),
  };
}
