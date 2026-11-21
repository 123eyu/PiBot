import type { ChatPeer } from "@pibot/client-core";
import { createContext, useContext } from "react";
import type { ChangesRequest } from "./use-changes-pane.ts";

/** A file one run changed, for the chat's file preview pane (same shape the desktop opens). */
export interface ChangedFilePreview {
  name: string;
  source: { runId: string; path: string };
}
/** What reply cards need from the surrounding chat: a peer and a way to open the sidebar. */
export interface ChangesLink {
  peer: ChatPeer;
  open(request: Omit<ChangesRequest, "seq">): void;
  /** Absent where the chat has no preview pane; files then open as diffs. */
  preview?(file: ChangedFilePreview): void;
}
export const ChangesLinkContext = createContext<ChangesLink | undefined>(undefined);
export const useChangesLink = () => useContext(ChangesLinkContext);
