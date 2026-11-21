import type { ChatPeer } from "@pibot/client-core";
import type { EventPayloads, Message } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import styles from "../chat.module.css";

// Capture before send returns IDs; display only after matching an actual visible message/run.
// Group/thread views can reuse this component with their own authoritative message window.
export function RunStatusNotice({ peer, messages }: { peer: ChatPeer; messages: Message[] }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<{
    peer: ChatPeer;
    entries: Map<string, EventPayloads["chat.status"]>;
  }>(() => ({ peer, entries: new Map() }));
  useEffect(() => {
    const entries = new Map<string, EventPayloads["chat.status"]>();
    setSnapshot({ peer, entries: new Map() });
    return peer.on("chat.status", (event) => {
      if (!event.runId || !event.messageId) return;
      if (event.state !== "running" || (!event.compacting && !event.reconnecting))
        entries.delete(event.runId);
      else entries.set(event.runId, event);
      while (entries.size > 128) entries.delete(entries.keys().next().value as string);
      setSnapshot({ peer, entries: new Map(entries) });
    });
  }, [peer]);
  const visible =
    snapshot.peer === peer
      ? messages.flatMap((message) => {
          const event = message.runId ? snapshot.entries.get(message.runId) : undefined;
          return message.status === "streaming" &&
            event &&
            event.messageId === message.id &&
            event.conversationId === message.conversationId &&
            event.botId === message.botId
            ? [event]
            : [];
        })
      : [];
  return visible.map((event) => (
    <p
      key={event.runId}
      className={`${styles.notice} ${styles.band}`}
      data-tone="info"
      role="status"
    >
      {event.reconnecting
        ? t("chat.reconnecting", {
            attempt: event.reconnecting.attempt,
            maxAttempts: event.reconnecting.maxAttempts,
          })
        : t("chat.compacting")}
    </p>
  ));
}
