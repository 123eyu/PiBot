import {
  locateConversation,
  useAction,
  useNavigation,
  useRpc,
  useWorkspace,
} from "@pibot/renderer-kit";

/**
 * Opens a topic by its conversation id (a `pibot://topic/...` reference or a proposal's source).
 * The id is model- or database-supplied, so the target is resolved through the existing locale
 * listing before navigating; an unknown one reports instead of leaving the user on a blank page.
 */
export function useTopicReference() {
  const { peer } = useRpc();
  const data = useWorkspace();
  const { navigate } = useNavigation();
  const action = useAction();
  const open = (conversationId: string, messageId?: string | null) => {
    if (!peer) return;
    void action.run(
      async (signal) => {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        const group = data.groups.find((item) => item.conversationId === conversationId);
        let target: Awaited<ReturnType<typeof locateConversation>>;
        if (group) {
          await peer.call(
            "groups.topics.switch",
            { groupId: group.id, topicId: conversationId },
            { signal: bounded, timeoutMs: 30_000 },
          );
          target = { name: "chat", groupId: group.id };
        } else {
          target = await locateConversation(peer, conversationId, bounded, data.bots, data.groups);
          // A group's own conversation comes back without a topic; a thread already carries one.
          if (target.groupId && !target.topicId && !target.threadId) {
            await peer.call(
              "groups.topics.switch",
              { groupId: target.groupId, topicId: conversationId },
              { signal: bounded, timeoutMs: 30_000 },
            );
          }
        }
        signal.throwIfAborted();
        navigate({
          ...target,
          ...(messageId ? { focus: { messageId } } : {}),
        });
      },
      () => "chat.topicUnavailable",
    );
  };
  return { open, busy: action.busy, error: action.error };
}
