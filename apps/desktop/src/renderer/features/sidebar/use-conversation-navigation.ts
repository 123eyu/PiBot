import { type useAction, useNavigation, useRpc, useWorkspace } from "@pibot/renderer-kit";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ConversationNavigation, navigationError } from "./conversation-navigation.ts";

export function useConversationNavigation(query: string, task: ReturnType<typeof useAction>) {
  const { peer } = useRpc();
  const data = useWorkspace();
  const { view, navigate } = useNavigation();
  const current = useRef({ query, data, view, navigate });
  current.current = { query, data, view, navigate };
  const controller = useMemo(
    () =>
      new ConversationNavigation(peer, {
        current: () => ({
          ...current.current.data,
          query: current.current.query,
          view: current.current.view,
        }),
        navigate: (target) => current.current.navigate(target),
        refresh: () => {
          // Used only when open acknowledgement had no matching sidebar.changed event.
          void current.current.data.refresh();
        },
      }),
    [peer],
  );
  controller.updateSource();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => controller.start(), [controller]);
  // Callers share this action feedback; unrelated mutation errors keep their owner.
  useEffect(() => {
    task.setError((previous) => (!previous || navigationError(previous) ? state.error : previous));
  }, [state.error, task.setError]);
  return {
    ...state,
    open: controller.open,
    openMessage: controller.openMessage,
    retry: controller.retry,
  };
}
