import type { ChatPeer } from "@pibot/client-core";
import type { MethodResults, ReviewFinding } from "@pibot/workspaces-contract/full";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dirName, type ListFile } from "../model.ts";
import type { ChangesTarget } from "../store.ts";

/** A review records findings one tool call at a time; re-read once the burst settles. */
const SETTLE_MS = 300;

/**
 * The newest review's findings for this conversation and folder. They are
 * stored with that run, so reopening the sidebar shows them again; "ignore" and "fix" persist.
 */
export function useReviews(
  peer: ChatPeer,
  target: ChangesTarget,
  files: readonly ListFile[],
  running: boolean,
) {
  const [findings, setFindings] = useState<readonly ReviewFinding[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<
    MethodResults["changes.reviews"]["freshness"] | "checking"
  >("checking");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewerName, setReviewerName] = useState<string>();
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify(target);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const off = peer.on("changes.changed", (event) => {
      if (event.reason === "stats") return;
      if (
        event.conversationKey &&
        (event.conversationKey !== target.conversationKey ||
          (event.topicId && event.topicId !== target.topicId))
      )
        return;
      // Hide actionable overlays immediately; a commit or edit may invalidate every line anchor.
      setFreshness("checking");
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => setRevision((value) => value + 1),
        event.reason === "review" ? SETTLE_MS : 1000,
      );
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [peer, target.conversationKey, target.topicId]);
  // A review that ends without findings sends no "review" event; its completion is what replaces
  // the previous findings, so re-read when a run of this conversation ends.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setRevision((value) => value + 1);
    wasRunning.current = running;
  }, [running]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads after a review event
  useEffect(() => {
    const abort = new AbortController();
    setFreshness("checking");
    peer
      .call("changes.reviews", JSON.parse(key) as ChangesTarget, {
        signal: abort.signal,
        timeoutMs: 30_000,
      })
      .then(
        (result) => {
          if (abort.signal.aborted) return;
          setFindings(result.findings);
          setRunId(result.runId);
          setFreshness(result.freshness);
          setReviewerName(result.reviewerName);
        },
        // Findings are an overlay; the diff stays usable without them.
        () => {
          if (!abort.signal.aborted) setFreshness("unavailable");
        },
      );
    return () => abort.abort();
  }, [peer, key, revision]);

  const open = useMemo(
    () => (freshness === "current" ? findings.filter((item) => item.state === "open") : []),
    [findings, freshness],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new topic/root must close its predecessor's history.
  useEffect(() => {
    setHistoryOpen(false);
    setFindings([]);
    setRunId(null);
    setReviewerName(undefined);
  }, [key]);
  /** Folder-relative display path → list file, so findings attach in every scope. */
  const byDisplay = useMemo(() => new Map(files.map((file) => [file.display, file])), [files]);
  const { perFile, rows } = useMemo(() => {
    const perFile = new Map<string, ReviewFinding[]>();
    for (const item of open) {
      const file = byDisplay.get(item.path);
      if (!file) continue;
      const list = perFile.get(file.key) ?? [];
      list.push(item);
      perFile.set(file.key, list);
    }
    // Row ids as FileList uses them: file rows count findings, folder rows count flagged files.
    const rows = new Map<string, number>();
    for (const [fileKey, list] of perFile) {
      rows.set(`f:${fileKey}`, list.length);
      const dir = dirName(list[0]?.path ?? "");
      if (dir) rows.set(`d:${dir}`, (rows.get(`d:${dir}`) ?? 0) + 1);
    }
    return { perFile, rows };
  }, [open, byDisplay]);

  const update = useCallback(
    async (ids: string[], state: ReviewFinding["state"]) => {
      if (!ids.length) return;
      // Optimistic: the card disappears at once; a failed write re-reads the stored state.
      setFindings((current) =>
        current.map((item) => (ids.includes(item.id) ? { ...item, state } : item)),
      );
      await peer
        .call("changes.reviewUpdate", { ...(JSON.parse(key) as ChangesTarget), ids, state })
        .catch(() => setRevision((value) => value + 1));
    },
    [peer, key],
  );
  const firstFile = open.map((item) => byDisplay.get(item.path)).find(Boolean);
  /** The newest review finished and found nothing (not: every finding was ignored or fixed). */
  const clean = freshness === "current" && runId !== null && findings.length === 0;
  return {
    open,
    perFile,
    rows,
    update,
    firstFile,
    clean,
    freshness,
    reviewerName,
    history: freshness === "current" ? [] : findings,
    historyOpen,
    toggleHistory: () => setHistoryOpen((v) => !v),
  };
}
export type Reviews = ReturnType<typeof useReviews>;
