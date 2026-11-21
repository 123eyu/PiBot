import type { Message } from "@pibot/protocol";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { useRuntime, useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import type { AvatarLook } from "../../ui/avatar.tsx";
import { useTimeText } from "../../ui/time.ts";
import { scopeTarget } from "../chat/controls/scope.ts";
import { MessageItem } from "../chat/messages/MessageItem.tsx";

// Only the current topic is needed here; the full row is validated where the chat page reads it.
const TopicsCacheSchema = z.object({ current: z.uuid().optional() });

/**
 * The Bot's chat as the phone last cached it, under the same keys the online chat page reads
 * first (topics → current topic → history), so going offline never empties a long conversation.
 * `ready` turns true once the read settled, found or not.
 */
export function useCachedHistory(computerId: string | undefined, botId: string, topic?: string) {
  const runtime = useRuntime();
  const [state, setState] = useState<{ messages: Message[]; ready: boolean }>({
    messages: [],
    ready: false,
  });
  useEffect(() => {
    let alive = true;
    setState({ messages: [], ready: false });
    const read = async () => {
      if (!computerId) return [];
      const topics = TopicsCacheSchema.safeParse(
        await runtime.storage.data.get(`cache:${computerId}:topics:bot:${botId}`),
      );
      // A record's own topic (route param) wins, as online; else the computer's current one.
      const topicId = topic ?? (topics.success ? topics.data.current : undefined);
      if (!topicId) return [];
      const target = scopeTarget({ kind: "bot", id: botId, topicId });
      return runtime.storage.history(computerId, JSON.stringify(target));
    };
    read()
      // An unreadable cache only means nothing earlier to show; the offline chat still works.
      .catch(() => [] as Message[])
      .then((messages) => {
        if (alive) setState({ messages, ready: true });
      });
    return () => {
      alive = false;
    };
  }, [runtime, computerId, botId, topic]);
  return state;
}

/** The line between the computer's and the phone's own replies (offline chat and the thread). */
export function OfflineDivider({ text }: { text: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.b2 }} />
      <Text
        style={{ flexShrink: 1, fontSize: 12, lineHeight: 18, color: colors.text2 }}
        numberOfLines={1}
      >
        {text}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.b2 }} />
    </View>
  );
}

/**
 * The cached history, read-only, drawn as the online thread draws it, then the line where the
 * phone's own model takes over. The phone gives that model the persona and selected memories, not
 * this history, so the note under the line says so instead of letting replies look forgetful.
 */
export function OfflineHistory({
  messages,
  look,
  userColor,
}: {
  messages: readonly Message[];
  look: AvatarLook | undefined;
  userColor: string;
}) {
  const colors = useColors(),
    t = useText(),
    time = useTimeText();
  const first = messages[0];
  if (!first) return null;
  return (
    <View style={{ gap: 14 }}>
      <Text style={{ alignSelf: "center", fontSize: 12, lineHeight: 18, color: colors.text2 }}>
        {time.stamp(first.createdAt)}
      </Text>
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          look={look}
          userColor={userColor}
          onPress={() => undefined}
        />
      ))}
      <OfflineDivider text={t("offlineHistoryDivider")} />
    </View>
  );
}
