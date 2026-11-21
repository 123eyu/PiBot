import { useEffect, useRef, useState } from "react";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";
import { useConversations } from "../conversations/conversations-context.tsx";
import {
  type Run,
  readTaskCenter,
  retryParams,
  type TaskCenter,
  TaskCenterSchema,
} from "./pages.ts";

export type PauseLength = "hour" | "day" | "week";
const PAUSE_MS: Record<PauseLength, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
};
/** Task center: recent runs, routine runs and restart continuations; control actions never queue. */
export function useTasks() {
  const runtime = useRuntime(),
    mobile = useLinkState(),
    conversations = useConversations();
  const [center, setCenter] = useState<TaskCenter>();
  // Maintainers 2026-11-14: tasks are live. The stored copy is shown only while the computer is
  // offline (with its offline notice), never as the current list of a connected computer.
  const [fromCache, setFromCache] = useState(false);
  const action = useAction(mobile.selectedId, mobile.peer);
  const write = useAction(mobile.selectedId, mobile.peer);
  const rows = useRef(conversations.rows);
  rows.current = conversations.rows;
  const cacheKey = `cache:${mobile.selectedId}:tasks`;
  const load = () =>
    action.read(async (signal) => {
      if (!mobile.selectedId) return;
      if (mobile.status !== "online") {
        const cached = TaskCenterSchema.safeParse(await runtime.storage.data.get(cacheKey));
        signal.throwIfAborted();
        if (cached.success) {
          setCenter(cached.data);
          setFromCache(true);
        }
        return;
      }
      const value = await readTaskCenter(runtime, rows.current, signal);
      signal.throwIfAborted();
      setCenter(value);
      setFromCache(false);
      await runtime.storage.data.put(cacheKey, TaskCenterSchema.parse(value));
    });
  const sources = conversations.rows.map((row) => row.key).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: effects own the canonical device/peer and conversation set.
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    };
    const off = [
      mobile.peer?.on("chat.status", refresh),
      mobile.peer?.on("routine.run", refresh),
      mobile.peer?.on("routines.changed", refresh),
      mobile.peer?.on("continuations.pending", refresh),
    ];
    return () => {
      clearTimeout(timer);
      for (const fn of off) fn?.();
    };
  }, [mobile.selectedId, mobile.peer, mobile.refreshVersion, sources]);
  const mutate = (operation: (signal: AbortSignal) => Promise<unknown>) =>
    write.run(async (signal) => {
      await operation(signal);
      signal.throwIfAborted();
      void load();
      return true;
    });
  const stale = fromCache && mobile.status === "online";
  return {
    center: stale ? undefined : center,
    /** Connected, and the computer's current list has not arrived yet. */
    loading: mobile.status === "online" && action.busy && (stale || !center),
    action,
    write,
    load,
    stopRun: (runId: string) => mutate((signal) => runtime.call("chat.abort", { runId }, signal)),
    retryRun: (run: Run) =>
      mutate((signal) => runtime.call("runs.retry", retryParams(run), signal)),
    continueChain: (conversationId: string) =>
      mutate((signal) =>
        runtime.call("continuations.resume", { conversationId, confirmed: true }, signal),
      ),
    runNow: (id: string) => mutate((signal) => runtime.call("routines.runNow", { id }, signal)),
    pause: (length: PauseLength) =>
      mutate((signal) =>
        runtime.call(
          "routines.pauseAll",
          { until: new Date(Date.now() + PAUSE_MS[length]).toISOString() },
          signal,
        ),
      ),
    resume: () => mutate((signal) => runtime.call("routines.resumeAll", undefined, signal)),
  };
}
