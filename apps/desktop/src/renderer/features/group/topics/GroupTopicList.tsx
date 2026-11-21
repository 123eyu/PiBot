import type { ChatPeer } from "@pibot/client-core";
import type { Group, GroupTopic } from "@pibot/protocol";
import { useAction, useNavigation, useT, useWorkspace } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";
import { useTimelineDay } from "../../chat/messages/MessageTime.tsx";
import { topicArchiveError } from "../../chat/topics/use-topic-archive.ts";
import { TopicListView } from "../../workspace/topics/TopicListView.tsx";
export function GroupTopicList({
  peer,
  group,
  changed,
  draft,
}: {
  peer: ChatPeer;
  group: Group;
  changed(): void;
  draft?: boolean;
}) {
  const t = useT(),
    workspace = useWorkspace(),
    { view } = useNavigation(),
    latest = useRef(view);
  latest.current = view;
  useTimelineDay();
  const task = useAction(),
    restoring = useAction(),
    [topics, setTopics] = useState<GroupTopic[]>([]),
    [archived, setArchived] = useState(false),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true),
    [unavailable, setUnavailable] = useState(false),
    [more, setMore] = useState(false),
    [revision, setRevision] = useState(0),
    [editing, setEditing] = useState<string>(),
    [title, setTitle] = useState("");
  const epoch = useRef(0),
    renameLock = useRef(false),
    lifetime = useRef(new AbortController());
  useEffect(() => {
    const signal = new AbortController();
    lifetime.current = signal;
    return () => signal.abort();
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((v) => v + 1), 250);
    };
    const off = [
      peer.on("groups.changed", (event) => {
        if (event.groupId === group.id) refresh();
      }),
      peer.on("chat.status", (event) => {
        if (event.groupId === group.id) refresh();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const stop of off) stop();
    };
  }, [peer, group.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: accepted topic creation/selection invalidates current marker
  useEffect(() => {
    const version = ++epoch.current;
    setLoading(true);
    setMore(false);
    setUnavailable(false);
    const cancel = new AbortController();
    const timer = setTimeout(
      () => {
        void peer
          .call(
            "groups.topics.list",
            { groupId: group.id, limit: 50, query, archived },
            { signal: cancel.signal, timeoutMs: 30000 },
          )
          .then((rows) => {
            if (
              rows.some(
                (topic) =>
                  topic.groupId !== group.id ||
                  topic.kind !== "group" ||
                  !!topic.archivedAt !== archived,
              )
            )
              throw new Error("Topic target mismatch");
            if (epoch.current === version) {
              setTopics(rows);
              setMore(rows.length === 50);
            }
          })
          .catch(() => {
            if (!cancel.signal.aborted && epoch.current === version) setUnavailable(true);
          })
          .finally(() => {
            if (epoch.current === version) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      cancel.abort();
      epoch.current++;
    };
  }, [
    peer,
    group.id,
    group.conversationId,
    group.topicArchivedAt,
    draft,
    query,
    archived,
    revision,
  ]);
  const select = async (topic: GroupTopic) => {
    const original = latest.current;
    const result = await task.run(
      (signal) =>
        peer.call(
          "groups.topics.switch",
          { groupId: group.id, topicId: topic.id },
          { signal, timeoutMs: 30000 },
        ),
      topicArchiveError,
    );
    if (result && latest.current === original && !lifetime.current.signal.aborted) {
      changed();
      void workspace.refresh();
    }
  };
  const restore = async (topicId: string) => {
    const original = latest.current;
    const result = await restoring.run(async (signal) => {
      const topic = await peer.call(
        "groups.topics.restore",
        { groupId: group.id, topicId },
        { signal, timeoutMs: 30000 },
      );
      if (topic.groupId !== group.id || topic.id !== topicId || topic.archivedAt)
        throw new Error("Restored topic mismatch");
      if (latest.current !== original || signal.aborted) return undefined;
      return peer.call(
        "groups.topics.switch",
        { groupId: group.id, topicId },
        { signal, timeoutMs: 30000 },
      );
    }, topicArchiveError);
    if (result && latest.current === original && !lifetime.current.signal.aborted) {
      changed();
      void workspace.refresh();
    }
  };
  const rename = async (topicId: string) => {
    if (renameLock.current) return;
    if (!title.trim()) {
      task.setError("workspace.invalid");
      return;
    }
    const topic = topics.find((value) => value.id === topicId);
    if (!topic || title.trim() === topic.title) {
      setEditing(undefined);
      return;
    }
    renameLock.current = true;
    const version = epoch.current;
    const result = await task.run((signal) =>
      peer.call(
        "groups.topics.rename",
        { groupId: group.id, topicId, title: title.trim() },
        { signal, timeoutMs: 30000 },
      ),
    );
    renameLock.current = false;
    if (result && version === epoch.current) {
      setEditing(undefined);
      setRevision((value) => value + 1);
    }
  };
  const statuses = new Map<string, "queued" | "running">();
  for (const status of Object.values(workspace.statuses))
    if (
      status.groupId === group.id &&
      status.state !== "idle" &&
      statuses.get(status.conversationId) !== "running"
    )
      statuses.set(status.conversationId, status.state);
  const waiting = new Set(
    workspace.inbox.flatMap((item) =>
      (item.kind === "approval" || item.kind === "routine_approval") &&
      item.approval.status === "pending"
        ? [item.conversationId]
        : [],
    ),
  );
  return (
    <TopicListView
      topics={topics.filter(
        (topic) => topic.groupId === group.id && !!topic.archivedAt === archived,
      )}
      currentId={draft ? undefined : group.conversationId}
      archived={archived}
      setArchived={setArchived}
      query={query}
      setQuery={setQuery}
      loading={loading}
      error={task.error ?? restoring.error ?? (unavailable ? "workspace.unavailable" : undefined)}
      retry={() => setRevision((value) => value + 1)}
      editing={editing}
      title={title}
      setTitle={setTitle}
      rename={(id) => void rename(id)}
      startRename={(topic) => {
        setTitle(topic.title ?? "");
        setEditing(topic.id);
      }}
      cancelRename={() => setEditing(undefined)}
      busy={task.busy}
      restoring={restoring.busy}
      available
      folderName={(topic) =>
        topic.folders.find((folder) => folder.id === topic.primaryFolderId)?.name ??
        t("folders.groupHome")
      }
      status={(topic) => (waiting.has(topic.id) ? "waiting" : statuses.get(topic.id))}
      open={(topic) => void select(topic)}
      restore={(id) => void restore(id)}
      more={more}
      loadMore={() => {
        const version = epoch.current;
        void task
          .run((signal) =>
            peer.call(
              "groups.topics.list",
              { groupId: group.id, before: topics.at(-1)?.id, limit: 50, query, archived },
              { signal, timeoutMs: 30000 },
            ),
          )
          .then((next) => {
            if (
              next &&
              version === epoch.current &&
              next.every((topic) => topic.groupId === group.id && !!topic.archivedAt === archived)
            ) {
              setTopics((previous) => {
                const ids = new Set(previous.map((topic) => topic.id));
                return [...previous, ...next.filter((topic) => !ids.has(topic.id))];
              });
              setMore(next.length === 50);
            }
          });
      }}
    />
  );
}
