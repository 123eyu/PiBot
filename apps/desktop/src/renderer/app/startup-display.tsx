import { type Bot, type Message, messageVisibleText } from "@pibot/protocol";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { StartupSnapshot } from "../../shared/startup-snapshot.ts";
import { snapshotLook, snapshotMembers } from "./startup-avatar.tsx";

const Context = createContext<{
  snapshot: StartupSnapshot | null;
  systemLocale: string;
  historySettled: boolean;
  readSettled: boolean;
  setReadSettled(value: boolean): void;
  setHistorySettled(value: boolean): void;
  setSnapshot(value: StartupSnapshot): void;
  conversation?: StartupSnapshot["conversation"];
  setConversation(value: StartupSnapshot["conversation"]): void;
  clear(): Promise<void>;
  cleared: boolean;
} | null>(null);
export function StartupDisplayProvider({
  initial,
  systemLocale,
  children,
}: {
  initial: StartupSnapshot | null;
  systemLocale: string;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [conversation, setConversation] = useState<StartupSnapshot["conversation"]>();
  const [historySettled, setHistorySettled] = useState(false);
  const [readSettled, setReadSettled] = useState(false);
  const [cleared, setCleared] = useState(false);
  return (
    <Context.Provider
      value={{
        snapshot,
        systemLocale,
        historySettled,
        readSettled,
        setReadSettled,
        setHistorySettled,
        setSnapshot,
        conversation,
        setConversation,
        cleared,
        clear: async () => {
          setCleared(true);
          setSnapshot(null);
          setConversation(undefined);
          if (!window.pibotStartup) throw new Error("startup_cache_unavailable");
          await window.pibotStartup.clear();
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useStartupDisplay() {
  return useContext(Context);
}

const isoTime = (value: string) => {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
};

/** Only committed display messages; never cache optimistic sends, tools, attachments or approvals. */
export function useDisplayConversation(input: {
  botId?: string;
  groupId?: string;
  topicId?: string;
  name: string;
  /** The private chat's Bot, for the header avatar and the user bubble color. */
  bot?: Bot;
  /** Group members: header avatar and each reply's sender. */
  bots?: readonly Bot[];
  /** True when `messages` reach back to the start of the topic. */
  complete?: boolean;
  messages: readonly Message[];
  ready: boolean;
  failed?: boolean;
  visible: boolean;
}) {
  const display = useStartupDisplay();
  const set = display?.setConversation;
  const settled = display?.setHistorySettled;
  const { botId, groupId, topicId, name, bot, bots, complete, messages, ready, failed, visible } =
    input;
  useEffect(() => {
    if (!set || !visible || (!ready && !failed)) return;
    settled?.(true);
    if (failed) return;
    const senders = new Map(bots?.map((member) => [member.id, member]));
    const shown = messages.filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.status === "done",
    );
    const at = (message: Message) => isoTime(message.createdAt);
    set({
      botId,
      groupId,
      topicId,
      name: name.slice(0, 200),
      ...(groupId ? snapshotMembers(bots ?? []) : bot ? { avatar: snapshotLook(bot) } : {}),
      complete: !!complete && shown.length <= 20,
      messages: shown.slice(-20).map((message) => {
        const sender = groupId && message.botId ? senders.get(message.botId) : undefined;
        const time = at(message);
        return {
          id: message.id,
          role: message.role === "user" ? "user" : "assistant",
          text: plainText(messageVisibleText(message)).slice(0, 4000),
          ...(time ? { at: time } : {}),
          ...(message.role === "assistant" && sender
            ? { sender: { name: sender.name.slice(0, 200), avatar: snapshotLook(sender) } }
            : {}),
        };
      }),
    });
  }, [
    set,
    settled,
    botId,
    groupId,
    topicId,
    name,
    bot,
    bots,
    complete,
    messages,
    ready,
    failed,
    visible,
  ]);
}
/**
 * The cached screen shows plain paragraphs (loading the Markdown renderer would slow the first
 * frame), so strip the common markers instead of showing `**…**` and backticks raw.
 */
function plainText(text: string) {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1");
}
