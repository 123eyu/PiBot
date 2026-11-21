import type { BackgroundCommand, BackgroundCommandRecord } from "@pibot/protocol";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { auditRead } from "../rpc.ts";

const PAGE = 50;
/** Ended history is bounded in memory like the other Records lists. */
const MAX_KEPT = 1000;

type State = "running" | "ended";
interface List {
  rows: BackgroundCommandRecord[];
  loading: boolean;
  error: boolean;
  more: boolean;
}
const emptyList: List = { rows: [], loading: true, error: false, more: false };

/**
 * Records · Background services: running commands and the ended history (paged with
 * `before`), across Bots or for one. `backgroundCommands.changed` keeps both live: a row that
 * ends moves from "running" to the top of "ended" with the chat it belonged to.
 */
export function useBackgroundServices(botId: string, groupId?: string, from?: string) {
  const { peer } = useRpc();
  const [lists, setLists] = useState<Record<State, List>>({
    running: emptyList,
    ended: emptyList,
  });
  // Bumped when the scope changes; late pages of an older scope are dropped.
  const generation = useRef(0);
  const reloadTimer = useRef<Partial<Record<State, ReturnType<typeof setTimeout>>>>({});
  const listsRef = useRef(lists);
  listsRef.current = lists;

  const load = useCallback(
    async (state: State, fresh: boolean) => {
      if (!peer) return;
      const version = generation.current;
      const before = fresh ? undefined : listsRef.current[state].rows.at(-1)?.id;
      setLists((old) => ({ ...old, [state]: { ...old[state], loading: true, error: false } }));
      const deadline = AbortSignal.timeout(30_000);
      try {
        const page = await auditRead(
          () =>
            peer.call("backgroundCommands.page", {
              state,
              limit: PAGE,
              from,
              ...(botId ? { botId } : {}),
              ...(groupId ? { groupId } : {}),
              ...(before ? { before } : {}),
            }),
          deadline,
        );
        if (version !== generation.current) return;
        if (
          page.some(
            (row) =>
              (botId && row.botId !== botId) ||
              (groupId && row.groupId !== groupId) ||
              (row.status === "running") !== (state === "running"),
          )
        )
          throw new Error("Background scope mismatch");
        setLists((old) => {
          const base = fresh ? [] : old[state].rows;
          const seen = new Set(base.map((row) => row.id));
          return {
            ...old,
            [state]: {
              rows: [...base, ...page.filter((row) => !seen.has(row.id))].slice(0, MAX_KEPT),
              loading: false,
              error: false,
              more: page.length === PAGE,
            },
          };
        });
      } catch {
        if (version === generation.current)
          setLists((old) => ({ ...old, [state]: { ...old[state], loading: false, error: true } }));
      }
    },
    [peer, botId, groupId, from],
  );

  useEffect(() => {
    generation.current++;
    setLists({ running: emptyList, ended: emptyList });
    void load("running", true);
    void load("ended", true);
    const timers = reloadTimer.current;
    return () => {
      generation.current++;
      for (const timer of Object.values(timers)) clearTimeout(timer);
      reloadTimer.current = {};
    };
  }, [load]);

  /** Coalesced reload of a list's first page (a new row needs its chat from the server). */
  const reload = useCallback(
    (state: State) => {
      if (reloadTimer.current[state]) return;
      reloadTimer.current[state] = setTimeout(() => {
        reloadTimer.current[state] = undefined;
        void load(state, true);
      }, 250);
    },
    [load],
  );

  useRpcEvent("backgroundCommands.changed", (row: BackgroundCommand) => {
    if (botId && row.botId !== botId) return;
    if (groupId && row.groupId !== groupId) return;
    if (from && (row.endedAt ?? row.startedAt) < from) return;
    const current = listsRef.current;
    const running = current.running.rows.find((item) => item.id === row.id);
    if (row.status === "running") {
      if (!running) reload("running");
      else
        setLists((old) => ({
          ...old,
          running: {
            ...old.running,
            rows: old.running.rows.map((item) =>
              item.id === row.id ? { ...row, place: item.place } : item,
            ),
          },
        }));
      return;
    }
    const ended = current.ended.rows.find((item) => item.id === row.id);
    const place = running?.place ?? ended?.place;
    if (place === undefined) {
      // Neither list had it (started and ended before the page loaded): fetch it with its chat.
      reload("ended");
      setLists((old) => ({
        ...old,
        running: { ...old.running, rows: old.running.rows.filter((item) => item.id !== row.id) },
      }));
      return;
    }
    setLists((old) => ({
      running: { ...old.running, rows: old.running.rows.filter((item) => item.id !== row.id) },
      ended: {
        ...old.ended,
        rows: [{ ...row, place }, ...old.ended.rows.filter((item) => item.id !== row.id)].slice(
          0,
          MAX_KEPT,
        ),
      },
    }));
  });

  return {
    running: lists.running,
    ended: lists.ended,
    retry: (state: State) => void load(state, !listsRef.current[state].rows.length),
    more: (state: State) => void load(state, false),
  };
}
