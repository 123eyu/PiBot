import type { ChatPeer } from "@pibot/client-core";
import { chatReadCache } from "@pibot/client-core";
import type { MethodResults, Workplaces } from "@pibot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

type Data = MethodResults["topics.workplace.get"];
export function useTopicWorkplace(
  peer: ChatPeer,
  botId?: string,
  topicId?: string,
  workplace?: Pick<Workplaces, "revision" | "currentId">,
  changing = false,
) {
  const reads = chatReadCache(peer);
  const [revision, setRevision] = useState(0);
  const owner = JSON.stringify([botId, topicId]);
  const previewKey = JSON.stringify(["topic-place", botId, topicId]);
  const known = useRef<{ peer: ChatPeer; owner: string; place?: string; generation: number }>({
    peer,
    owner,
    generation: 0,
  });
  const place = workplace ? JSON.stringify([workplace.revision, workplace.currentId]) : undefined;
  if (known.current.peer !== peer || known.current.owner !== owner)
    known.current = { peer, owner, place, generation: 0 };
  else if (place !== undefined && place !== known.current.place) {
    if (known.current.place !== undefined) known.current.generation++;
    known.current.place = place;
  }
  // Receiving the first Bot directory is not a change: the topic read already runs independently.
  // A binding change hides the prior folder in this render; an event refresh keeps it until replaced.
  const binding = JSON.stringify([botId, topicId, known.current.generation, changing]);
  const readKey = JSON.stringify([binding, revision]);
  const [value, setValue] = useState<{ peer: ChatPeer; binding: string; data: Data }>();
  const [failure, setFailure] = useState<{
    peer: ChatPeer;
    key: string;
    missing: boolean;
    offline: boolean;
  }>();
  const busy = useRef(false);
  busy.current = value?.binding === binding && value.data.busy;
  useEffect(() => {
    if (!botId || !topicId) return;
    // Sidebar changes include archival before navigation. Only root changes invalidate this read.
    const offFolder = peer.on("changes.changed", (event) => {
      if (
        event.reason === "folder" &&
        event.conversationKey === `dm:${botId}` &&
        event.topicId === topicId
      )
        setRevision((value) => value + 1);
    });
    // `chat.done` arrives before the run queue releases the topic, so a read made then still says
    // busy; the queue's `sidebar.changed` after settling is the first moment it reads idle. Only a
    // busy topic re-reads here, and archival needs an idle topic, so this never races archival.
    const offSidebar = peer.on("sidebar.changed", (event) => {
      if (busy.current && (!event.conversationKey || event.conversationKey === `dm:${botId}`))
        setRevision((value) => value + 1);
    });
    return () => {
      offFolder();
      offSidebar();
    };
  }, [peer, botId, topicId]);
  useEffect(() => {
    if (!botId || !topicId || changing) return;
    const abort = new AbortController();
    setFailure(undefined);
    void reads
      .read(
        JSON.stringify(["topic-place", botId, topicId]),
        (signal) => peer.call("topics.workplace.get", { botId, topicId }, { signal }),
        abort.signal,
      )
      .then((data) => {
        if (abort.signal.aborted) return;
        if (data.topicId !== topicId) throw new Error("Topic identity changed");
        reads.rememberPreview(previewKey, data);
        setValue({ peer, binding, data });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        // The brain names a deleted / moved folder so the chat can say so instead of "couldn't load".
        const message = error instanceof Error ? error.message : "";
        const missing = message.includes("workplace_folder_missing");
        // A topic moved onto a runner reads as "couldn't load" while that runner is away; name it.
        const offline = /runner_target_offline|runner_offline|runner_disconnected/.test(message);
        setFailure({ peer, key: readKey, missing, offline });
      });
    return () => abort.abort();
  }, [peer, botId, topicId, reads, binding, readKey, changing, previewKey]);
  const confirmed = value?.peer === peer && value.binding === binding;
  const data = confirmed
    ? value.data
    : !changing && known.current.generation === 0
      ? reads.preview<Data>(previewKey)
      : undefined;
  const error = failure?.peer === peer && failure.key === readKey;
  const missing = error && failure?.missing === true;
  const runnerOffline = error && failure?.offline === true;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { data, confirmed, error, missing, runnerOffline, refresh };
}
