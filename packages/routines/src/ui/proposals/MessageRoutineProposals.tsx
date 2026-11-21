import { type Peer, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback } from "react";
import { usePages } from "../page/paging.ts";
import { useProposalRefresh } from "./proposal-refresh.ts";
import { RoutineProposalCard } from "./RoutineProposalCard.tsx";

export function MessageRoutineProposals({
  botId,
  messageId,
}: {
  botId: string;
  messageId: string;
}) {
  const t = useT();
  const load = useCallback(
    async (peer: Peer, before?: string) => {
      const items = await peer.call("routines.proposals", { botId, messageId, before, limit: 50 });
      if (items.some((p) => p.botId !== botId || p.messageId !== messageId))
        throw new Error("Proposal owner changed");
      return items;
    },
    [botId, messageId],
  );
  const list = usePages(load);
  useProposalRefresh(list.refresh, { botId, messageId });
  return (
    <>
      {list.rows.map((p) => (
        <RoutineProposalCard key={p.id} proposal={p} />
      ))}
      {list.error && (
        <p role="alert">
          {t("routines.failed")} <Button onClick={list.refresh}>{t("common.retry")}</Button>
        </p>
      )}
      {list.more && (
        <Button disabled={list.loading} onClick={() => void list.next()}>
          {t("routines.more")}
        </Button>
      )}
    </>
  );
}
