import { useRpc, useT } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import styles from "./auto-check.module.css";
import { FolderCommands } from "./FolderCommands.tsx";
import { useAutoCheck } from "./use-auto-check.ts";

/**
 * The conversation's folder menu also shows (and edits) that folder's check commands,
 * when one of the conversation's Bots has the automatic check on. Nothing is shown otherwise.
 */
export function AutoCheckFolderMenu({
  botIds,
  conversationId,
  nameOf,
}: {
  botIds: readonly string[];
  conversationId: string | undefined;
  nameOf(botId: string): string;
}) {
  const { peer } = useRpc();
  const [botId, setBotId] = useState<string>();
  const key = botIds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the identity of botIds.
  useEffect(() => {
    setBotId(undefined);
    if (!peer || !botIds.length) return;
    let active = true;
    const load = () =>
      Promise.all(
        botIds.map((id) => peer.call("autoCheck.get", { botId: id }).catch(() => undefined)),
      ).then((all) => {
        if (active) setBotId(all.find((value) => value?.enabled)?.botId);
      });
    const off = peer.on("autoCheck.changed", (event) => {
      if (event.reason === "settings") void load();
    });
    void load();
    return () => {
      active = false;
      off();
    };
  }, [peer, key]);
  if (!botId || !conversationId) return null;
  return <Entry botId={botId} conversationId={conversationId} botName={nameOf(botId)} />;
}

function Entry({
  botId,
  conversationId,
  botName,
}: {
  botId: string;
  conversationId: string;
  botName: string;
}) {
  const t = useT();
  const { peer } = useRpc();
  const check = useAutoCheck(peer, botId, conversationId);
  return (
    <div className={styles.menu}>
      <p className={styles.menuHeading}>{t("autoCheck.menuTitle")}</p>
      <FolderCommands folder={check.folder} botName={botName} save={check.setCommands} />
    </div>
  );
}
