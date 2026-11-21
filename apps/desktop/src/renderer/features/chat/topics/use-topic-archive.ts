import type { ChatPeer } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import { RpcError } from "@pibot/protocol";
import { actionError, useAction, useNavigation } from "@pibot/renderer-kit";
import { useRef } from "react";

export function topicArchiveError(error: unknown): TranslationKey {
  if (error instanceof RpcError) {
    if (["topic_archive_busy", "topic_workplace_busy", "group_topic_busy"].includes(error.message))
      return "topic.archiveBusy";
    if (error.message === "topic_archive_routine") return "topic.archiveRoutine";
    if (
      ["topic_unavailable", "group_topic_unavailable", "group_topic_stale"].includes(error.message)
    )
      return "topic.unavailable";
  }
  return actionError(error);
}

export function useTopicArchive(
  peer: ChatPeer | null | undefined,
  botId?: string,
  topicId?: string,
) {
  const action = useAction();
  const { navigate, view } = useNavigation();
  const latest = useRef(view);
  latest.current = view;
  return {
    available: !!peer && !!botId && !!topicId,
    busy: action.busy,
    error: action.error,
    run: async () => {
      if (!peer || !botId || !topicId) return;
      const original = latest.current;
      const result = await action.run(
        (signal) => peer.call("topics.archive", { botId, topicId }, { signal, timeoutMs: 15000 }),
        topicArchiveError,
      );
      // A late mutation receipt must not navigate away from a different topic or page.
      if (result && latest.current === original)
        navigate({ name: "chat", botId, draftId: crypto.randomUUID() });
    },
  };
}

export function useTopicRestore(peer: ChatPeer | null | undefined, botId: string) {
  const action = useAction();
  const { navigate, view } = useNavigation();
  const latest = useRef(view);
  latest.current = view;
  return {
    busy: action.busy,
    error: action.error,
    run: async (topicId: string) => {
      if (!peer) return;
      const original = latest.current;
      const result = await action.run(async (signal) => {
        const restored = await peer.call(
          "topics.restore",
          { botId, topicId },
          { signal, timeoutMs: 15000 },
        );
        if (restored.botId !== botId || restored.id !== topicId || restored.archivedAt)
          throw new Error("Restored topic mismatch");
        if (latest.current !== original || signal.aborted) return undefined;
        return peer.call("topics.switch", { botId, topicId }, { signal, timeoutMs: 15000 });
      }, topicArchiveError);
      // List refreshes caused by this operation must not invalidate its own navigation receipt.
      if (result && latest.current === original) navigate({ name: "chat", botId, topicId });
    },
  };
}

/** Group archive uses the same menu/draft transition without altering Bot DM settings. */
export function useGroupTopicArchive(
  peer: ChatPeer | null | undefined,
  groupId?: string,
  topicId?: string,
) {
  const action = useAction(),
    { navigate, view } = useNavigation(),
    latest = useRef(view);
  latest.current = view;
  return {
    available: !!peer && !!groupId && !!topicId,
    busy: action.busy,
    error: action.error,
    run: async () => {
      if (!peer || !groupId || !topicId) return;
      const original = latest.current;
      const result = await action.run(
        (signal) =>
          peer.call("groups.topics.archive", { groupId, topicId }, { signal, timeoutMs: 30000 }),
        topicArchiveError,
      );
      if (result && latest.current === original)
        navigate({ name: "chat", groupId, draftId: crypto.randomUUID() });
    },
  };
}
