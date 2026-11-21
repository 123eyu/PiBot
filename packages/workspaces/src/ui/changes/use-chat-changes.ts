import type { ChatPeer } from "@pibot/client-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface SidePaneControl {
  open: boolean;
  tab: string;
  show(tab: "changes"): void;
  close(): void;
}

import type { ChangedFilePreview, ChangesLink } from "./context.ts";
import { useChangesSource } from "./store.ts";
import type { ChangesRequest } from "./use-changes-pane.ts";

/**
 * Wires one chat (DM topic or group) to the changes sidebar: the header pill's status, open
 * requests from the pill and reply cards, and the context value reply cards read.
 */
export function useChatChanges({
  peer,
  conversationKey,
  topicId,
  active,
  pane,
  otherPanelOpen,
  closeOtherPanel,
  preview,
}: {
  peer: ChatPeer;
  conversationKey?: string;
  topicId?: string;
  active: boolean;
  pane: SidePaneControl;
  /** The profile / group panel shares the right edge; only one of them is open at a time. */
  otherPanelOpen: boolean;
  closeOtherPanel(): void;
  /** Opens a changed file in the chat's preview pane; keep it stable (it is part of the link). */
  preview?(file: ChangedFilePreview): void;
}) {
  const target = useMemo(
    () => (conversationKey ? { conversationKey, ...(topicId ? { topicId } : {}) } : undefined),
    [conversationKey, topicId],
  );
  const { state } = useChangesSource(peer, target, active);
  const [request, setRequest] = useState<ChangesRequest>();
  const seq = useRef(0);
  const { show, close, open: paneOpen, tab } = pane;
  const open = useCallback(
    (next: Omit<ChangesRequest, "seq">) => {
      setRequest({ ...next, seq: ++seq.current });
      show("changes");
    },
    [show],
  );
  const togglePill = useCallback(() => {
    if (paneOpen && tab === "changes") close();
    else open({ scope: "uncommitted" });
  }, [paneOpen, tab, close, open]);
  const link = useMemo<ChangesLink>(
    () => ({ peer, open, ...(preview ? { preview } : {}) }),
    [peer, open, preview],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: react only when the other panel opens
  useEffect(() => {
    if (otherPanelOpen) close();
  }, [otherPanelOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: react only when this sidebar opens
  useEffect(() => {
    if (paneOpen && otherPanelOpen) closeOtherPanel();
  }, [paneOpen]);
  return { state, request, link, togglePill, target };
}
