import type { ChatPeer } from "@pibot/client-core";
import type { ConversationYolo } from "@pibot/protocol";
import { useCallback, useEffect, useState } from "react";

/**
 * The YOLO switch of one conversation (DM topic or group conversation). `state` is null
 * while unknown or when the conversation cannot have one (a draft, a routine's topic), in which
 * case no control is shown. Other windows follow through `conversations.yolo.changed`.
 */
export function useConversationYolo(peer: ChatPeer | null | undefined, conversationId?: string) {
  const [state, setState] = useState<ConversationYolo | null>(null);
  useEffect(() => {
    setState(null);
    if (!peer || !conversationId) return;
    let active = true;
    const load = () =>
      peer.call("conversations.yolo.get", { conversationId }).then(
        (value) => {
          if (active) setState(value);
        },
        () => {
          // Unavailable here (routine topic, archived, older brain): show no switch.
          if (active) setState(null);
        },
      );
    const offs = [
      peer.on("conversations.yolo.changed", (event) => {
        if (event.conversationId !== conversationId) return;
        setState((current) => (current ? { ...current, ...event } : current));
      }),
      // A restarted brain may have answered changes this window missed.
      peer.on("brain.status", (event) => {
        if (event.state === "ready") void load();
      }),
    ];
    void load();
    return () => {
      active = false;
      for (const off of offs) off();
    };
  }, [peer, conversationId]);
  const set = useCallback(
    async (enabled: boolean) => {
      if (!peer || !conversationId) return undefined;
      const value = await peer.call("conversations.yolo.set", { conversationId, enabled });
      setState(value);
      return value;
    },
    [peer, conversationId],
  );
  return { state, set };
}
