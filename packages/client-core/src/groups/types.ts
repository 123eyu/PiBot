import type { EventPayloads, FolderSelection, Message } from "@pibot/protocol";
import type { RequestError } from "../chat/types.ts";

export interface Snapshot {
  messages: Message[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  paging: boolean;
  refreshing: boolean;
  sending: boolean;
  confirmed: boolean;
  acceptedConversationId?: string;
  requestError?:
    | RequestError
    | "append_unavailable"
    | "append_full"
    | "append_duplicate"
    | "append_target_required";
  appendUncertain?: boolean;
}
export type Delta = EventPayloads["chat.delta"];
export interface GroupTarget {
  groupId: string;
  conversationId: string;
  threadId?: string;
  draftId?: string;
  draftSelection?: FolderSelection;
}
