import { type ChatAdditionMode, chatReplyTo, type Message } from "@pibot/protocol";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { AdditionStatus } from "../composer/SendOptions.tsx";
import { useMessageFocus } from "../messages/use-message-focus.ts";
import { useMessageScroll } from "../messages/use-message-scroll.ts";
import type { ConnectedChatProps } from "./chat-screen-model.ts";
import type { useChatState } from "./use-chat-state.tsx";

export function useChatMessages({
  visible,
  view,
  consumeChatFocus,
  controller,
  state,
  setText,
  retryDraft,
  reply,
  setMediaError,
  draftMode,
  isDraft,
  activity,
  resetInputHistory,
  scroll,
  messageContent,
  atBottom,
  anchor,
  notices,
  sendingBlocked,
  waiting,
  model,
  attachments,
}: ConnectedChatProps & ReturnType<typeof useChatState>) {
  const retryCache = useRef(new Map<string, { text: string; ids: string[] } | undefined>());
  const retries = useMemo(() => {
    const result = new Map<string, { text: string; ids: string[] } | undefined>();
    const users = new Map(
      state.messages
        .filter((message) => message.role === "user")
        .map((message) => [message.id, message]),
    );
    let previousUser: { text: string; ids: string[] } | undefined;
    for (const message of state.messages) {
      if (message.role === "user")
        previousUser = {
          text: message.content,
          ids: message.attachments?.map((item) => item.id) ?? [],
        };
      else {
        const inputId = chatReplyTo(message);
        const input = inputId ? users.get(inputId) : undefined;
        const owned =
          input && input.conversationId === message.conversationId && input.runId === message.runId;
        result.set(
          message.id,
          inputId
            ? owned
              ? {
                  text: input.content,
                  ids: input.attachments?.map((item) => item.id) ?? [],
                }
              : undefined
            : previousUser,
        );
      }
    }
    // Reuse unchanged entries so a streaming delta does not hand every message a new ids array.
    const previous = retryCache.current;
    for (const [id, entry] of result) {
      const old = previous.get(id);
      if (
        entry &&
        old &&
        old.text === entry.text &&
        old.ids.length === entry.ids.length &&
        old.ids.every((value, index) => value === entry.ids[index])
      )
        result.set(id, old);
    }
    retryCache.current = result;
    return result;
  }, [state.messages]);
  // Element identity per message object: deltas keep other messages' references, so memo holds.
  const footers = useRef(new WeakMap<Message, ReactNode>());
  const userFooter = (message: Message) => {
    if (!state.historyReady) return undefined;
    let footer = footers.current.get(message);
    if (!footer) {
      footer = (
        <AdditionStatus
          message={message}
          {...(state.bot
            ? {
                target: {
                  kind: "dm" as const,
                  botId: state.bot.id,
                  agent: state.bot.kind === "agent",
                },
              }
            : {})}
        />
      );
      footers.current.set(message, footer);
    }
    return footer;
  };

  const messageFocus = useMessageFocus({
    controller,
    focus: view.focus,
    consume: consumeChatFocus,
    scroll,
    atBottom,
    anchor,
  });
  const messageScroll = useMessageScroll({
    identity: controller,
    active: visible,
    pending: messageFocus.pending,
    holdPosition: messageFocus.holdPosition,
    scroll,
    content: messageContent,
    atBottom,
    anchor,
    messageIds: state.messages.map((message) => message.id),
    cancelFocus: messageFocus.cancel,
  });
  // Message commits change DOM height even though the effect only reads the scroll container.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize after history and delta commits
  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container || !visible || messageFocus.pending) return;
    if (anchor.current && !state.loadingMore) {
      container.scrollTop = anchor.current.top + container.scrollHeight - anchor.current.height;
      anchor.current = undefined;
    } else if (!anchor.current && atBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [
    state.messages,
    state.loading,
    state.loadingMore,
    activity.state,
    notices,
    messageFocus.pending,
    visible,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: These state setters and refs retain their original hook identity across this extraction.
  const send = useCallback(
    async (value: string, ids?: string[], mode: ChatAdditionMode = "steer") => {
      const inputs = ids ? [] : attachments.drafts.map((item) => item.input);
      const attachmentIds = ids ?? retryDraft.attachments.map((item) => item.id);
      if (
        sendingBlocked ||
        state.loading ||
        attachments.reading ||
        (!value.trim() && !inputs.length && !attachmentIds.length)
      )
        return;
      if (state.bot?.category === "image" && !ids && inputs.length) {
        if (inputs.some((input) => input.kind !== "image")) {
          setMediaError("media.imageOnly");
          return;
        }
        const mode = inputs.length ? "image-to-image" : "text-to-image";
        if (!model || !("modes" in model) || !model.modes.includes(mode)) {
          setMediaError("media.modeMismatch");
          return;
        }
      }
      setMediaError(undefined);
      messageFocus.cancel();
      atBottom.current = true;
      const accepted = await controller.send(
        value,
        inputs,
        attachmentIds.length ? attachmentIds : undefined,
        // ACP agents cannot take input mid-turn; a plain Enter waits for the turn to end.
        waiting ? "queue" : state.bot?.kind === "agent" && mode === "steer" ? "followUp" : mode,
        isDraft ? draftMode : undefined,
        ids ? undefined : reply?.draft?.message.id,
      );
      if (accepted) {
        resetInputHistory();
        if (!ids) {
          attachments.clear();
          retryDraft.clear();
          if (reply?.draft) reply.clear(reply.draft.message.id);
          setText((current) => (current === value ? "" : current));
        }
      }
    },
    [
      sendingBlocked,
      waiting,
      isDraft,
      draftMode,
      state.bot,
      model,
      state.loading,
      controller,
      attachments,
      retryDraft,
      resetInputHistory,
      setText,
      reply,
      messageFocus.cancel,
    ],
  );
  return { retries, userFooter, messageFocus, messageScroll, send };
}
