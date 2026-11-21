import { useEffect, useRef } from "react";

/**
 * "Open in Bot browser" from a chat line or from Records asks the chat showing that Bot to
 * switch its side pane to the browser. A request made just before navigating to the chat waits
 * briefly for that chat to mount; a stale one is ignored.
 */
const PENDING_MS = 10_000;
type Listener = (botId: string, groupId?: string) => boolean;
const listeners = new Set<Listener>();
let pending: { botId: string; groupId?: string; at: number } | undefined;

export function requestBrowserPane(botId: string, groupId?: string) {
  pending = { botId, groupId, at: Date.now() };
  for (const listener of listeners) if (listener(botId, groupId)) pending = undefined;
}

/** Shows the browser tab when a request names one of `botIds`; returns nothing. */
export function useBrowserPaneRequests(
  botIds: readonly string[],
  show: (botId: string) => void,
  groupId?: string,
) {
  const latest = useRef({ botIds, show, groupId });
  latest.current = { botIds, show, groupId };
  const key = botIds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check a waiting request when the chat's Bots change
  useEffect(() => {
    const listener: Listener = (botId, requestGroupId) => {
      if (latest.current.groupId !== requestGroupId) return false;
      if (!latest.current.botIds.includes(botId)) return false;
      latest.current.show(botId);
      return true;
    };
    listeners.add(listener);
    if (pending && Date.now() - pending.at < PENDING_MS && listener(pending.botId, pending.groupId))
      pending = undefined;
    return () => {
      listeners.delete(listener);
    };
  }, [key, groupId]);
}
