import { useEffect, useRef, useState } from "react";
import { type LogIndex, type LogSnapshot, retainedMatch } from "./index-log.ts";

const emptySnapshot: LogSnapshot = {
  text: "",
  query: "",
  wrap: 0,
  revision: 0,
  index: {
    rows: new Uint32Array(),
    matches: new Uint32Array(),
    columns: 0,
    points: new Uint32Array(),
    anchors: new Uint32Array(),
  },
};
export function useLogIndex(text: string, query: string, wrap: number) {
  const [selection, setSelection] = useState({ snapshot: emptySnapshot, active: 0 });
  const [failure, setFailure] = useState<{ text: string; query: string; wrap: number }>();
  const [jump, setJump] = useState(0);
  const revision = useRef(0);
  const { snapshot, active } = selection;
  const pending = snapshot.text !== text || snapshot.query !== query || snapshot.wrap !== wrap;
  useEffect(() => {
    const current = ++revision.current;
    setFailure(undefined);
    let worker: Worker | undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      worker = new Worker(new URL("./index.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<LogIndex>) => {
        if (cancelled) return;
        const next = { text, query, wrap, revision: current, index: event.data };
        // Text, query and wrapping belong to this job, never to the latest controls.
        setSelection((previous) => ({
          snapshot: next,
          active: retainedMatch(previous.snapshot, previous.active, next),
        }));
        worker?.terminate();
      };
      worker.onerror = () => {
        if (!cancelled) setFailure({ text, query, wrap });
        worker?.terminate();
      };
      worker.postMessage({ text, query, wrap });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [text, query, wrap]);
  const failed =
    pending && failure?.text === text && failure.query === query && failure.wrap === wrap;
  const indexing = pending && !failed;
  const navigate = (direction: number) => {
    if (pending || !snapshot.index.matches.length) return;
    setSelection((value) => ({
      ...value,
      active:
        (value.active + direction + value.snapshot.index.matches.length) %
        value.snapshot.index.matches.length,
    }));
    setJump((value) => value + 1);
  };
  return { snapshot, active, jump, indexing, pending, failed, navigate };
}
