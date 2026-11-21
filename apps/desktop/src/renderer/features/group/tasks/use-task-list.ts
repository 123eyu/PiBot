import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask, MethodResults } from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";

export type TaskOrigin = "all" | "user" | "coordinator";
export function useTaskList(
  peer: ChatPeer,
  groupId: string,
  origin: TaskOrigin,
  closed: boolean,
  revision: number,
) {
  const [limits, setLimits] = useState({ open: 50, closed: 50 });
  const [state, setState] = useState<{
    key: string;
    open: GroupTask[];
    closed: GroupTask[];
    error: boolean;
    busy: boolean;
  }>({ key: "", open: [], closed: [], error: false, busy: true });
  const key = `${groupId}:${origin}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different group/filter resets the page window
  useEffect(() => {
    setLimits({ open: 50, closed: 50 });
  }, [groupId, origin]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision invalidates data after durable task/run events
  useEffect(() => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    setState((s) =>
      s.key === key
        ? { ...s, busy: true, error: false }
        : { key, open: [], closed: [], busy: true, error: false },
    );
    const params = { groupId, origin: origin === "all" ? undefined : origin };
    const read = async (section: "open" | "closed", maximum: number) => {
      const tasks: GroupTask[] = [];
      let before: string | undefined;
      while (tasks.length < maximum) {
        const page = await waitRpc(
          () =>
            peer.call("groups.tasks", {
              ...params,
              section,
              before,
              limit: Math.min(50, maximum - tasks.length),
            }),
          signal,
        );
        tasks.push(...page);
        if (page.length < 50) break;
        const next = page.at(-1)?.id;
        if (!next || next === before) throw new Error("Task cursor did not advance");
        before = next;
      }
      return tasks;
    };
    void Promise.all([
      read("open", limits.open),
      closed ? read("closed", limits.closed) : Promise.resolve([]),
    ])
      .then(([open, done]) => {
        if (!signal.aborted) setState({ key, open, closed: done, busy: false, error: false });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState((s) => ({ ...s, busy: false, error: true }));
      });
    return () => abort.abort();
  }, [peer, groupId, origin, key, closed, limits, revision]);
  return {
    ...(state.key === key ? state : { open: [], closed: [], error: false, busy: true }),
    more: (section: "open" | "closed") => setLimits((s) => ({ ...s, [section]: s[section] + 50 })),
  };
}

export function useTaskBatches(peer: ChatPeer, groupId: string, messageIds: string[]) {
  const key = JSON.stringify(messageIds);
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{
    key: string;
    groupId: string;
    result?: MethodResults["groups.tasks.summary"];
  }>({ key: "", groupId: "" });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((r) => r + 1), 250);
    };
    const off = [
      peer.on("group.task", ({ task }) => {
        if (task.groupId === groupId) schedule();
      }),
      peer.on("chat.status", (event) => {
        if (event.groupId === groupId) schedule();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const dispose of off) dispose();
    };
  }, [peer, groupId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision invalidates data after durable task/run events
  useEffect(() => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    const read = async () => {
      const ids = JSON.parse(key) as string[];
      const result: MethodResults["groups.tasks.summary"] = {
        openCount: 0,
        closedCount: 0,
        batches: [],
        collaborations: [],
      };
      const readMessages = async (
        messageIds: string[],
      ): Promise<MethodResults["groups.tasks.summary"]> => {
        const page = await waitRpc(
          () => peer.call("groups.tasks.summary", { groupId, messageIds }),
          signal,
        );
        // Accepted parent messages have bounded rounds; split full pages to preserve older rows.
        if (page.collaborations.length === 200 && messageIds.length > 1) {
          const middle = Math.ceil(messageIds.length / 2);
          const left = await readMessages(messageIds.slice(0, middle));
          const right = await readMessages(messageIds.slice(middle));
          page.collaborations = [...left.collaborations, ...right.collaborations];
        }
        return page;
      };
      for (let start = 0; start < ids.length; start += 200) {
        const page = await readMessages(ids.slice(start, start + 200));
        result.batches.push(...page.batches);
        result.collaborations.push(...page.collaborations);
      }
      return result;
    };
    void read()
      .then((result) => {
        if (!abort.signal.aborted) setValue({ key, groupId, result });
      })
      .catch(() => {
        if (!abort.signal.aborted) setValue({ key, groupId });
      });
    return () => abort.abort();
  }, [peer, groupId, key, revision]);
  const result = value.key === key && value.groupId === groupId ? value.result : undefined;
  const collaborations = new Map<string, NonNullable<typeof result>["collaborations"]>();
  for (const item of result?.collaborations ?? []) {
    const list = collaborations.get(item.messageId) ?? [];
    list.push(item);
    collaborations.set(item.messageId, list);
  }
  return {
    batches: new Map((result?.batches ?? []).map((batch) => [batch.messageId, batch])),
    collaborations,
  };
}
