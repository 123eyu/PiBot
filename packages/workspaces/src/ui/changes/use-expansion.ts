import type { ChatPeer } from "@pibot/client-core";
import type { ChangesDiff, DiffHunk } from "@pibot/workspaces-contract/full";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DiffLine, gapRange, type ListFile } from "./model.ts";
import type { ChangesTarget } from "./store.ts";
import type { DiffSource } from "./use-pane-data.ts";

/** Lines revealed per click; a whole gap at most this many per request (changes.lines cap). */
export const EXPAND_STEP = 20;
const REQUEST_MAX = 2000;

/** Revealed context of one gap: `top` continues below the previous hunk, `bottom` sits above the next. */
export interface GapState {
  top: DiffLine[];
  bottom: DiffLine[];
  loading?: boolean;
  error?: boolean;
}
export interface Expansion {
  gaps: ReadonlyMap<number, GapState>;
  /** Newer-side line count, known only for files with an unchanged tail (modified files). */
  total: number | null;
  /** "near": up to EXPAND_STEP lines next to the following hunk (or below the last one). */
  expand(index: number, mode: "near" | "all"): void;
}

const ctx = (from: number, offset: number, lines: string[]): DiffLine[] =>
  lines.map((text, at) => ({
    kind: "ctx",
    old: from + at + offset,
    new: from + at,
    text: text.endsWith("\r") ? text.slice(0, -1) : text,
  }));

/**
 * "N unchanged lines" become expandable. Reads go through changes.lines (brain reads
 * the newer side read-only, size-limited); state resets whenever a new diff arrives.
 */
export function useExpansion(
  peer: ChatPeer,
  target: ChangesTarget,
  source: DiffSource,
  file: ListFile | undefined,
  diff: ChangesDiff | undefined,
): Expansion {
  const [gaps, setGaps] = useState<ReadonlyMap<number, GapState>>(new Map());
  const [total, setTotal] = useState<number | null>(null);
  const hunks: readonly DiffHunk[] | undefined = diff?.hunks;
  const generation = useRef(0);
  const live = useRef(new Set<AbortController>());
  // Keys, not objects: the pane rebuilds `target` / `source` on every render.
  const targetKey = JSON.stringify(target);
  const sourceKey =
    source.scope === "commit"
      ? `commit:${source.commit}`
      : source.scope === "turn"
        ? `turn:${source.runId}`
        : "uncommitted:";
  const fileKey = file?.key ?? "";
  const params = useCallback(
    (from: number, count: number) => {
      const base = { ...(JSON.parse(targetKey) as ChangesTarget), path: fileKey, from, count };
      const [scope, id = ""] = sourceKey.split(":") as [DiffSource["scope"], string];
      return scope === "commit"
        ? { ...base, scope, commit: id }
        : scope === "turn"
          ? { ...base, scope, runId: id }
          : { ...base, scope: "uncommitted" as const };
    },
    [targetKey, fileKey, sourceKey],
  );
  const call = useCallback(
    (from: number, count: number) => {
      const abort = new AbortController();
      live.current.add(abort);
      return peer
        .call("changes.lines", params(from, count), { signal: abort.signal, timeoutMs: 30_000 })
        .finally(() => live.current.delete(abort));
    },
    [peer, params],
  );
  // A modified file may continue after its last hunk; only then is the total worth a read.
  const wantsTotal =
    !!hunks?.length && !!file && !file.binary && (file.tag === "M" || file.tag === "T");
  useEffect(() => {
    generation.current++;
    for (const abort of live.current) abort.abort();
    live.current.clear();
    setGaps(new Map());
    setTotal(null);
    if (!hunks || !wantsTotal) return;
    const version = generation.current;
    call(1, 0).then(
      (result) => version === generation.current && setTotal(result.total),
      () => undefined, // No total simply means no trailing "N more lines" row.
    );
  }, [hunks, wantsTotal, call]);
  useEffect(
    () => () => {
      for (const abort of live.current) abort.abort();
    },
    [],
  );

  const expand = useCallback(
    (index: number, mode: "near" | "all") => {
      if (!hunks) return;
      const range = gapRange(hunks, index, total);
      if (!range) return;
      const current = gaps.get(index) ?? { top: [], bottom: [] };
      if (current.loading) return;
      const remaining = range.to - range.from + 1 - current.top.length - current.bottom.length;
      if (remaining <= 0) return;
      const trailing = index === hunks.length;
      const count = Math.min(remaining, mode === "all" ? REQUEST_MAX : EXPAND_STEP);
      // "near" grows upward from the next hunk; the trailing gap and "all" grow downward.
      const below = mode === "all" || trailing;
      const from = below
        ? range.from + current.top.length
        : range.to - current.bottom.length - count + 1;
      const version = generation.current;
      const set = (next: GapState) =>
        version === generation.current && setGaps((map) => new Map(map).set(index, next));
      set({ ...current, loading: true, error: false });
      call(from, count).then(
        (result) => {
          const lines = ctx(from, range.offset, result.lines.slice(0, count));
          set(
            below
              ? { top: [...current.top, ...lines], bottom: current.bottom }
              : { top: current.top, bottom: [...lines, ...current.bottom] },
          );
        },
        () => set({ ...current, loading: false, error: true }),
      );
    },
    [hunks, total, gaps, call],
  );
  return { gaps, total, expand };
}
