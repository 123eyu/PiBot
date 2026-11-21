import { BrowserPane, useBrowserActivity } from "@pibot/browser/ui";
import type { Peer } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";
import { useBrowserPaneRequests } from "./browser-requests.ts";
import type { SidePaneControl } from "./use-side-pane.ts";

/**
 * Activity only updates the indicator. Only explicit user requests switch the open pane.
 */
export function useBrowserSlot(
  botId: string | undefined,
  options: { peer: Peer | null; running: boolean; pane: SidePaneControl; otherPanelOpen: boolean },
) {
  const activity = useBrowserActivity(botId, { running: options.running, peer: options.peer });
  // The user opened a page in this Bot's browser (chat line or Records): show it.
  const { show } = options.pane;
  useBrowserPaneRequests(botId ? [botId] : [], () => show("browser"));
  return activity.active || activity.sleeping;
}

export function BrowserSlot({
  botId,
  botName,
  groupId,
  peer,
  pane,
  running,
  conversationId,
  onFeedback,
}: {
  botId: string;
  botName: string;
  groupId?: string;
  peer: Peer | null;
  pane: SidePaneControl;
  running: boolean;
  conversationId?: string;
  onFeedback?(conversationId: string, text: string): void;
}) {
  // One header row. The side pane draws none for this tab; the browser's own header
  // carries fullscreen, wide and close.
  return (
    <BrowserPane
      botId={botId}
      botName={botName}
      groupId={groupId}
      peer={peer}
      running={running}
      conversationId={conversationId}
      onFeedback={onFeedback}
      wide={pane.wide}
      onToggleWide={pane.full ? pane.toggleWide : undefined}
      onClose={pane.full ? pane.close : undefined}
      fullscreen={pane.full}
      onToggleFullscreen={pane.toggleFull}
    />
  );
}

/** Reports one member's browser activity; renders nothing (hooks cannot loop over members). */
function BrowserWatch({
  botId,
  peer,
  running,
  report,
  groupId,
}: {
  botId: string;
  peer: Peer | null;
  running: boolean;
  report(botId: string, active: boolean): void;
  groupId?: string;
}) {
  const { active, sleeping } = useBrowserActivity(botId, { running, peer, groupId });
  // A sleeping browser still offers its tabs in the pane.
  const shown = active || sleeping;
  useEffect(() => {
    report(botId, shown);
    return () => report(botId, false);
  }, [botId, shown, report]);
  return null;
}

/**
 * Group chats: whichever member is using its browser gets the tab (the first one in member
 * order when several are). Returns the watchers to render and the Bot to show.
 */
export function useGroupBrowserSlot(
  botIds: string[],
  options: {
    groupId: string | undefined;
    peer: Peer | null;
    running: boolean;
    pane: SidePaneControl;
    otherPanelOpen: boolean;
  },
) {
  const [activeIds, setActiveIds] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback((botId: string, active: boolean) => {
    setActiveIds((previous) => {
      if (previous.has(botId) === active) return previous;
      const next = new Set(previous);
      if (active) next.add(botId);
      else next.delete(botId);
      return next;
    });
  }, []);
  // The member whose browser the user just opened a page in is shown first.
  const [preferred, setPreferred] = useState<string>();
  const { show } = options.pane;
  const scopedBotIds = options.groupId ? botIds : [];
  useBrowserPaneRequests(
    scopedBotIds,
    (id) => {
      setPreferred(id);
      show("browser");
    },
    options.groupId,
  );
  const botId =
    preferred && activeIds.has(preferred)
      ? preferred
      : scopedBotIds.find((id) => activeIds.has(id));
  const watchers = scopedBotIds.map((id) => (
    <BrowserWatch
      key={`${options.groupId}:${id}`}
      botId={id}
      groupId={options.groupId}
      peer={options.peer}
      running={options.running}
      report={report}
    />
  ));
  return { botId, watchers };
}
