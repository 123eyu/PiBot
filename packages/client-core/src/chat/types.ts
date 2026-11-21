import type {
  AgentErrorCode,
  AttachmentInput,
  Bot,
  EventPayloads,
  FolderSelection,
  ImageModelInfo,
  Message,
  ModelInfo,
} from "@pibot/protocol";
import type { ClientPeer } from "../rpc/peer.ts";
export interface ChatTarget {
  botId?: string;
  topicId?: string;
  draftId?: string;
}
export type ChatPeer = Pick<ClientPeer, "call" | "on">;
export type RequestError =
  | AgentErrorCode
  | "busy"
  | "uncertain"
  | "image_steer_unsupported"
  | "image_unsupported"
  | "attachment_invalid"
  | "scanned_pdf_unsupported"
  | "attachment_conversion"
  | "mention_unresolved"
  | "quote_unavailable"
  | "topic_busy";
export type ChatRequestError =
  | RequestError
  | "append_unavailable"
  | "append_full"
  | "append_duplicate";
export interface PendingChatAddition {
  requestId: string;
  botId: string;
  topicId: string;
  runId: string;
  text: string;
  attachments: AttachmentInput[];
  attachmentIds: string[];
}
export interface ChatState {
  needsFreshTopic?: boolean;
  bot?: Bot;
  conversationId?: string;
  models: ModelInfo[];
  imageModels: ImageModelInfo[];
  messages: Message[];
  loading: boolean;
  historyReady: boolean;
  historyError: boolean;
  metadataError: boolean;
  metadataLoading: boolean;
  /** A Bot or model read went unanswered (slow start) and is being retried; not an error yet. */
  metadataRetrying?: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  pending: boolean;
  stopping: boolean;
  stopError: boolean;
  requestError?: ChatRequestError;
  retryText?: string;
  appendUncertain?: boolean;
  /** The brain says the current model's context is too small for this topic. */
  contextHint?: boolean;
  /** The folders a new-topic draft starts with; sent with its first message. */
  draftWorkplace?: FolderSelection;
}
export type ChatEvent =
  | { kind: "message"; payload: EventPayloads["chat.message"] }
  | { kind: "attachments"; payload: EventPayloads["chat.attachments"] }
  | { kind: "delta"; payload: EventPayloads["chat.delta"] }
  | { kind: "done"; payload: EventPayloads["chat.done"] }
  | { kind: "error"; payload: EventPayloads["chat.error"] };
