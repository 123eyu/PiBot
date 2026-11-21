import { useRpc } from "@pibot/renderer-kit";
import { useEffect } from "react";

export function useProposalRefresh(
  refresh: () => void,
  scope: {
    botId: string;
    messageId?: string | null;
    proposalId?: string;
    routineId?: string;
    enabled?: boolean;
  },
) {
  const { peer } = useRpc();
  const { botId, messageId, proposalId, routineId, enabled = true } = scope;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = peer?.on("routines.changed", (event) => {
      if (event.proposalId) {
        if (proposalId && event.proposalId !== proposalId) return;
        if (messageId && event.messageId !== messageId) return;
        if (event.botId && event.botId !== botId) return;
      } else if (event.id) {
        if (!routineId || event.id !== routineId) return;
      } else if (event.botId && event.botId !== botId) return;
      // Global invalidations remain compatible; run status events cannot change a proposal.
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, 250);
    });
    return () => {
      clearTimeout(timer);
      off?.();
    };
  }, [peer, refresh, botId, messageId, proposalId, routineId, enabled]);
}
