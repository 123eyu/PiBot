import type { GroupConversation } from "@pibot/client-core";
import type { MessageFocusController } from "../../chat/messages/use-message-focus.ts";

export function groupFocusController(controller: GroupConversation): MessageFocusController {
  return {
    // GroupConversationView owns start/disposal. The shared hook waits for its loading snapshot.
    start: async () => {},
    subscribe: controller.subscribe,
    getSnapshot: () => {
      const state = controller.getSnapshot();
      return {
        ...state,
        loadingMore: state.paging || state.refreshing,
        historyError: state.error,
        metadataError: false,
      };
    },
    loadMore: controller.more,
  };
}
