import type { BackgroundCommand, Message } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { useEffect, useMemo, useState } from "react";
import { BackgroundCommandLine } from "./BackgroundLine.tsx";
import { loadBackgroundResults } from "./background-finished-results.ts";

/** Only presentation is replaced; the persisted system message remains the model's input. */
export function BackgroundFinished({
  message,
  botId,
  groupId,
  preview,
}: {
  message: Message;
  botId?: string;
  groupId?: string;
  preview: boolean;
}) {
  const { peer } = useRpc();
  const t = useT();
  const usage = message.usage;
  const values = usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {};
  const ids = useMemo(() => {
    const data = usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {};
    return Array.isArray(data.backgroundCommandIds)
      ? data.backgroundCommandIds.filter((id): id is string => typeof id === "string").slice(0, 32)
      : typeof data.backgroundCommandId === "string"
        ? [data.backgroundCommandId]
        : [];
  }, [usage]);
  const owner = typeof values.backgroundBotId === "string" ? values.backgroundBotId : botId;
  const key = JSON.stringify([message.conversationId, owner, groupId, ids]);
  const [found, setFound] = useState<{
    peer: typeof peer;
    key: string;
    rows: BackgroundCommand[];
    missing: number;
  }>();
  useEffect(() => {
    if (!peer || preview || !ids.length || (!owner && !groupId)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    void loadBackgroundResults(
      peer,
      ids,
      { conversationId: message.conversationId, botId: owner, groupId },
      signal,
    ).then(
      (result) => {
        if (!controller.signal.aborted) setFound({ peer, key, ...result });
      },
      () => {
        if (!controller.signal.aborted)
          setFound({ peer, key, rows: [], missing: new Set(ids).size });
      },
    );
    return () => controller.abort();
  }, [peer, key, ids, owner, groupId, preview, message.conversationId]);
  const result = found?.peer === peer && found.key === key ? found : undefined;
  if (!preview && ids.length && (owner || groupId))
    return (
      <>
        {result?.rows.map((row) => (
          <BackgroundCommandLine key={row.id} row={row} presentation="event" />
        ))}
        {!result ? (
          <span>{t("background.resultsLoading")}</span>
        ) : result.missing > 0 ? (
          <span>{t("background.resultsMissing", { count: result.missing })}</span>
        ) : null}
      </>
    );
  return (
    <span>
      <span aria-hidden="true">✓</span> {t("background.finished")}
    </span>
  );
}
