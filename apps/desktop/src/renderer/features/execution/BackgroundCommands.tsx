import { useRpc, useT } from "@pibot/renderer-kit";
import { BackgroundCommandLine } from "../chat/status/BackgroundLine.tsx";
import { useBackgroundRows } from "../chat/status/background-commands.ts";
import { compareBackgroundCommands } from "./background-command-order.ts";
import styles from "./execution.module.css";

export function BackgroundCommands({
  botId,
  conversationId,
}: {
  botId: string;
  conversationId?: string;
}) {
  const { peer } = useRpc();
  const t = useT();
  const rows = useBackgroundRows(peer, botId, !!conversationId, conversationId);
  const commands = [...rows.values()]
    .filter((row) => row.conversationId === conversationId)
    .sort(compareBackgroundCommands);
  if (!commands.length) return null;
  return (
    <section className={styles.topic} aria-label={t("background.section")}>
      <h3 data-tone="teal">
        {t("background.section")} · {commands.length}
      </h3>
      {commands.map((row) => (
        <BackgroundCommandLine key={row.id} row={row} presentation="task" />
      ))}
    </section>
  );
}
