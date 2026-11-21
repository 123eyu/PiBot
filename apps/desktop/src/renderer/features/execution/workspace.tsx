import type { ExecutionTopic } from "@pibot/client-core";
import type { ExecutionMode, ExecutionSettings, TaskSummary, TodoPlan } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import { createContext, useContext, useEffect, useRef, useState } from "react";

export type { ExecutionTopic } from "@pibot/client-core";

export function useExecutionWorkspace(
  bots: readonly { id: string; name: string }[],
  conversationId: string | undefined,
  open: (botId?: string, taskId?: string) => void,
  groupId?: string,
) {
  const { peer } = useRpc();
  const key = JSON.stringify([conversationId, bots.map(({ id, name }) => [id, name])]);
  const [snapshot, setSnapshot] = useState<{ key: string; topics: ExecutionTopic[] }>({
    key: "",
    topics: [],
  });
  const [retry, setRetry] = useState(0);
  // The plan strip asks the pane to scroll to one member's plan; a new nonce re-runs it on repeat clicks.
  const [planReveal, setPlanReveal] = useState<{ botId: string; nonce: number }>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const mutations = useRef(new Set<string>());
  const hiddenTasks = useRef(new Set<string>());
  const taskVersions = useRef(new Map<string, number>());
  const rememberTask = (task: TaskSummary) => {
    if ((taskVersions.current.get(task.id) ?? -1) > task.version) return false;
    taskVersions.current.set(task.id, task.version);
    if (task.archivedAt || task.deletedAt) hiddenTasks.current.add(task.id);
    else hiddenTasks.current.delete(task.id);
    if (taskVersions.current.size > 1000) {
      const oldest = taskVersions.current.keys().next().value;
      if (oldest) {
        taskVersions.current.delete(oldest);
        hiddenTasks.current.delete(oldest);
      }
    }
    return !hiddenTasks.current.has(task.id);
  };
  const topics = snapshot.key === key ? snapshot.topics : [];
  const merge = (botId: string, update: (topic: ExecutionTopic) => ExecutionTopic) =>
    setSnapshot((current) =>
      current.key !== key
        ? current
        : {
            ...current,
            topics: current.topics.map((topic) => (topic.botId === botId ? update(topic) : topic)),
          },
    );
  // A route owns its reads and subscriptions; an old response can never populate a new topic.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry invalidates reads in the same canonical scope.
  useEffect(() => {
    // A reveal belongs to the route that asked for it; a stale one must not scroll another conversation.
    setPlanReveal(undefined);
    if (!peer || !conversationId) return;
    const controller = new AbortController();
    hiddenTasks.current.clear();
    taskVersions.current.clear();
    lifetime.current = controller;
    const parsed = JSON.parse(key) as [string, [string, string][]];
    setSnapshot((current) => ({
      key,
      topics: parsed[1].map(([botId, name]) => {
        const old =
          current.key === key ? current.topics.find((topic) => topic.botId === botId) : undefined;
        return {
          ...old,
          botId,
          name,
          tasks: old?.tasks ?? [],
          next: old?.next ?? null,
          loading: true,
          error: false,
          mutating: false,
        };
      }),
    }));
    const update = (botId: string, action: (topic: ExecutionTopic) => ExecutionTopic) => {
      if (controller.signal.aborted) return;
      setSnapshot((current) =>
        current.key !== key
          ? current
          : {
              key,
              topics: current.topics.map((topic) =>
                topic.botId === botId ? action(topic) : topic,
              ),
            },
      );
    };
    const off = [
      peer.on("groups.execution.changed", (value) => {
        if (!groupId || value.groupId !== groupId) return;
        for (const [botId] of parsed[1])
          update(botId, (topic) => ({
            ...topic,
            settings:
              topic.settings && value.version >= topic.settings.version
                ? {
                    ...topic.settings,
                    mode: value.mode,
                    limits: value.limits,
                    version: value.version,
                    updatedAt: value.updatedAt,
                  }
                : topic.settings,
          }));
      }),
      peer.on("execution.changed", (value) => {
        if (value.conversationId === conversationId)
          update(value.botId, (topic) => ({
            ...topic,
            settings:
              !topic.settings || value.version >= topic.settings.version ? value : topic.settings,
          }));
      }),
      peer.on("execution.todo.changed", (value) => {
        if (value.conversationId === conversationId)
          update(value.botId, (topic) => {
            if (topic.plan && value.version < topic.plan.version) return topic;
            return { ...topic, plan: value };
          });
      }),
      peer.on("execution.task.changed", (value) => {
        if (value.conversationId !== conversationId) return;
        if ((taskVersions.current.get(value.id) ?? -1) > value.version) return;
        rememberTask(value);
        update(value.botId, (topic) => {
          const prior = topic.tasks.find((task) => task.id === value.id);
          if (prior && prior.version > value.version) return topic;
          if (value.archivedAt || value.deletedAt)
            return { ...topic, tasks: topic.tasks.filter((task) => task.id !== value.id) };
          const tasks = prior
            ? topic.tasks.map((task) => (task.id === value.id ? value : task))
            : [value, ...topic.tasks].slice(0, 100);
          return { ...topic, tasks };
        });
      }),
    ];
    for (const [botId] of parsed[1]) {
      const scope = { botId, conversationId },
        options = { signal: controller.signal, timeoutMs: 10_000 };
      void Promise.all([
        peer.call("execution.get", scope, options),
        peer.call("execution.todo.get", scope, options),
        peer.call("execution.tasks.list", { ...scope, limit: 25 }, options),
      ]).then(
        ([settings, plan, page]) =>
          update(botId, (topic) => {
            const tasks = new Map(page.items.filter(rememberTask).map((task) => [task.id, task]));
            for (const task of topic.tasks)
              if (
                taskVersions.current.get(task.id) === task.version &&
                !hiddenTasks.current.has(task.id) &&
                (tasks.get(task.id)?.version ?? -1) <= task.version
              )
                tasks.set(task.id, task);
            return {
              ...topic,
              loading: false,
              settings:
                (topic.settings?.version ?? -1) > settings.version ? topic.settings : settings,
              plan: (topic.plan?.version ?? -1) > plan.version ? topic.plan : plan,
              tasks: [...tasks.values()]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 100),
              next: page.nextBefore,
            };
          }),
        () => update(botId, (topic) => ({ ...topic, loading: false, error: true })),
      );
    }
    return () => {
      controller.abort();
      for (const stop of off) stop();
    };
  }, [peer, key, conversationId, groupId, retry]);
  const accept = (value: ExecutionSettings) =>
    merge(value.botId, (topic) => ({
      ...topic,
      settings: !topic.settings || value.version >= topic.settings.version ? value : topic.settings,
    }));
  const changeMode = async (botId: string, mode: ExecutionMode) => {
    if (groupId) {
      const settings = topics.find((topic) => topic.settings)?.settings,
        signal = lifetime.current?.signal,
        key = `group:${groupId}`;
      if (!peer || !settings || !signal || signal.aborted || mutations.current.has(key)) return;
      mutations.current.add(key);
      for (const topic of topics) merge(topic.botId, (value) => ({ ...value, mutating: true }));
      try {
        const next = await peer.call(
          "groups.execution.set",
          { groupId, expectedVersion: settings.version, mode },
          { signal, timeoutMs: 10000 },
        );
        if (!signal.aborted)
          for (const topic of topics)
            merge(topic.botId, (value) => ({
              ...value,
              settings:
                value.settings && next.version >= value.settings.version
                  ? {
                      ...value.settings,
                      mode: next.mode,
                      limits: next.limits,
                      version: next.version,
                      updatedAt: next.updatedAt,
                    }
                  : value.settings,
            }));
      } catch {
        if (!signal.aborted)
          for (const topic of topics) merge(topic.botId, (value) => ({ ...value, error: true }));
      } finally {
        mutations.current.delete(key);
        if (!signal.aborted)
          for (const topic of topics)
            merge(topic.botId, (value) => ({ ...value, mutating: false }));
      }
      return;
    }
    const topic = topics.find((entry) => entry.botId === botId),
      signal = lifetime.current?.signal;
    if (
      !peer ||
      !conversationId ||
      !topic?.settings ||
      !signal ||
      signal.aborted ||
      mutations.current.has(botId)
    )
      return;
    mutations.current.add(botId);
    merge(botId, (topic) => ({ ...topic, mutating: true }));
    try {
      const next = await peer.call(
        "execution.set",
        { botId, conversationId, expectedVersion: topic.settings.version, mode },
        { signal, timeoutMs: 10000 },
      );
      if (!signal.aborted) accept(next);
    } catch {
      if (!signal.aborted) merge(botId, (value) => ({ ...value, error: true }));
    } finally {
      mutations.current.delete(botId);
      if (!signal.aborted) merge(botId, (topic) => ({ ...topic, mutating: false }));
    }
  };
  const changeStep = async (
    botId: string,
    id: string,
    status: TodoPlan["items"][number]["status"],
  ) => {
    const plan = topics.find((entry) => entry.botId === botId)?.plan,
      signal = lifetime.current?.signal;
    if (
      !peer ||
      !conversationId ||
      !plan ||
      !signal ||
      signal.aborted ||
      mutations.current.has(botId)
    )
      return;
    mutations.current.add(botId);
    merge(botId, (topic) => ({ ...topic, mutating: true }));
    try {
      const next = await peer.call(
        "execution.todo.set",
        {
          botId,
          conversationId,
          expectedVersion: plan.version,
          goal: plan.goal,
          items: plan.items.map((item) => (item.id === id ? { ...item, status } : item)),
        },
        { signal, timeoutMs: 10_000 },
      );
      if (!signal.aborted)
        merge(botId, (topic) => ({
          ...topic,
          plan: !topic.plan || next.version >= topic.plan.version ? next : topic.plan,
        }));
    } catch {
      if (!signal.aborted) merge(botId, (value) => ({ ...value, error: true }));
    } finally {
      mutations.current.delete(botId);
      if (!signal.aborted) merge(botId, (topic) => ({ ...topic, mutating: false }));
    }
  };
  const older = async (botId: string) => {
    const topic = topics.find((entry) => entry.botId === botId),
      signal = lifetime.current?.signal;
    if (
      !peer ||
      !conversationId ||
      !topic?.next ||
      topic.loading ||
      topic.tasks.length >= 100 ||
      !signal ||
      signal.aborted
    )
      return;
    merge(botId, (value) => ({ ...value, loading: true }));
    try {
      const page = await peer.call(
        "execution.tasks.list",
        { botId, conversationId, before: topic.next, limit: 25 },
        { signal, timeoutMs: 10_000 },
      );
      if (!signal.aborted)
        merge(botId, (value) => {
          const ids = new Set(value.tasks.map((task) => task.id));
          return {
            ...value,
            loading: false,
            next: page.nextBefore,
            tasks: [
              ...value.tasks,
              ...page.items.filter((task) => rememberTask(task) && !ids.has(task.id)),
            ].slice(0, 100),
          };
        });
    } catch {
      if (!signal.aborted) merge(botId, (value) => ({ ...value, loading: false, error: true }));
    }
  };
  return {
    topics,
    groupId,
    conversationId,
    open,
    planReveal,
    revealPlan: (botId: string) => {
      setPlanReveal((current) => ({ botId, nonce: (current?.nonce ?? 0) + 1 }));
      open(botId);
    },
    accept,
    changeMode,
    changeStep,
    older,
    retry: () => setRetry((value) => value + 1),
  };
}
export type ExecutionWorkspace = ReturnType<typeof useExecutionWorkspace>;
export const ExecutionContext = createContext<ExecutionWorkspace | null>(null);
export const useExecution = () => useContext(ExecutionContext);
