import type {
  AgentErrorCode,
  Bot,
  EventPayloads,
  Group,
  InboxItem,
  Message,
  SidebarEntry,
  SidebarGroup,
} from "@pibot/protocol";
import { createContext, useContext } from "react";

export interface Summary {
  updatedAt?: string;
  preview: string;
  /** Display facts only: localize program text without rewriting ordinary message prose. */
  previewSource?: Pick<Message, "role" | "runId" | "routineTrigger"> & {
    systemEvent?: "background_finished" | "background_restart" | "other";
  };
  // A failed latest reply has no text to preview; the row shows its error reason instead.
  failed?: AgentErrorCode;
  conversationId?: string;
  topicId?: string;
}
export interface WorkspaceData {
  bots: Bot[];
  groups: Group[];
  entries: SidebarEntry[];
  sections: SidebarGroup[];
  inbox: InboxItem[];
  inboxCount: number;
  archivedCount?: number;
  summaries: Record<string, Summary>;
  statuses: Record<string, EventPayloads["chat.status"]>;
  uncertainGroups: string[];
  uncertainBots?: string[];
  loading: boolean;
  refreshing: boolean;
  detailsLoading: boolean;
  detailsError: boolean;
  error: boolean;
  unavailable: boolean;
  hasMore: boolean;
  hasMoreBots: boolean;
  hasMoreSections: boolean;
}
export const emptyWorkspace: WorkspaceData = {
  bots: [],
  groups: [],
  entries: [],
  sections: [],
  inbox: [],
  inboxCount: 0,
  archivedCount: 0,
  summaries: {},
  statuses: {},
  uncertainGroups: [],
  uncertainBots: [],
  loading: true,
  refreshing: false,
  detailsLoading: true,
  detailsError: false,
  error: false,
  unavailable: false,
  hasMore: false,
  hasMoreBots: false,
  hasMoreSections: false,
};
export interface WorkspaceValue extends WorkspaceData {
  refresh(): Promise<void>;
  more(): Promise<void>;
  moreBots(): Promise<void>;
  moreSections(): Promise<void>;
}
/** Filled by the desktop `WorkspaceProvider`. */
export const WorkspaceContext = createContext<WorkspaceValue | undefined>(undefined);

export function useWorkspace() {
  const data = useContext(WorkspaceContext);
  if (!data) throw new Error("WorkspaceProvider is required");
  return data;
}
