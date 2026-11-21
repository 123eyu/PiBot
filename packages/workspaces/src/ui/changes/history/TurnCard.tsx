import type { ActivityState } from "@pibot/client-core";
import { PopupMenu, RevealFileButton, useT } from "@pibot/renderer-kit";
import { IconTile } from "@pibot/ui";
import type { Message } from "@pibot/workspaces-contract/full";
import { memo, type ReactNode, useMemo } from "react";
import styles from "../changes.module.css";
import { useChangesLink } from "../context.ts";
import { FileStat, formatCount, Tag } from "../diff/FileList.tsx";
import { ChangesIcon } from "../icons.tsx";
import { baseName, fromTurnFile, sumLines } from "../model.ts";
import { useRunTurn } from "../store.ts";

/** Tools that can leave files changed; only replies that used one ask for their turn. */
const WRITING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "run_command",
  "office_create",
  "office_edit",
]);
const LISTED = 3;

/**
 * "This turn changed N files" under a finished reply; hidden when nothing changed.
 * `receipt` renders the run's work receipt: as this card's footer when the card shows
 * (`embedded` true), otherwise on its own, so one reply never gets two cards.
 */
export const TurnCard = memo(function TurnCard({
  message,
  activity,
  receipt,
  bare = false,
}: {
  message: Message;
  activity?: ActivityState;
  receipt?: (embedded: boolean) => ReactNode;
  /** Drawn inside another card (a direct chat's end-of-turn card): no frame of its own. */
  bare?: boolean;
}) {
  const link = useChangesLink();
  const settled = message.role === "assistant" && message.status !== "streaming";
  const wrote =
    settled &&
    !!message.runId &&
    (message.tools?.some((tool) => WRITING_TOOLS.has(tool.tool)) ||
      activity?.tools.some(
        (tool) => tool.messageId === message.id && WRITING_TOOLS.has(tool.tool),
      ));
  const turn = useRunTurn(link?.peer, wrote ? (message.runId ?? undefined) : undefined);
  // Wait for the turn before choosing standalone vs footer, so the receipt does not jump.
  if (link && wrote && !turn.data && turn.loading) return null;
  if (
    !link ||
    !wrote ||
    !turn.data ||
    (!turn.data.files.length && !turn.data.restoredCount) ||
    !message.runId
  )
    return receipt?.(false) ?? null;
  return (
    <Card
      runId={message.runId}
      data={turn.data}
      open={link.open}
      preview={link.preview}
      footer={receipt?.(true)}
      bare={bare}
    />
  );
});

function Card({
  runId,
  data,
  open,
  preview,
  footer,
  bare,
}: {
  bare: boolean;
  runId: string;
  data: NonNullable<ReturnType<typeof useRunTurn>["data"]>;
  open: NonNullable<ReturnType<typeof useChangesLink>>["open"];
  preview: NonNullable<ReturnType<typeof useChangesLink>>["preview"];
  footer?: ReactNode;
}) {
  const t = useT();
  const files = useMemo(() => data.files.map(fromTurnFile), [data.files]);
  const lines = sumLines(files);
  const title =
    !files.length && data.restoredCount ? "checkpoint.allRestored" : "changes.card.title";
  return (
    <section
      className={bare ? `${styles.card} ${styles.cardBare}` : styles.card}
      aria-label={t(title, { count: data.total })}
    >
      <div className={styles.cardTop}>
        <IconTile icon="file" tone="green" size="sm" />
        <b>{t(title, { count: data.total })}</b>
        {!!lines.added && <span className={styles.plus}>+{formatCount(lines.added)}</span>}
        {!!lines.removed && <span className={styles.minus}>−{formatCount(lines.removed)}</span>}
        <button
          type="button"
          className={styles.cardOpen}
          onClick={() => open({ scope: "turn", runId })}
        >
          {t("changes.card.view")}
          <ChangesIcon name="right" size={13} />
        </button>
      </div>
      {files.slice(0, LISTED).map((file) => (
        <div key={file.key} className={styles.cardFile}>
          <button
            type="button"
            className={styles.fileName}
            // Readable formats open like attachments; the rest (and deletions) keep the diff,
            // which 「查看」 still shows for every file.
            onClick={() =>
              preview && file.previewable
                ? preview({ name: baseName(file.display), source: { runId, path: file.key } })
                : open({ scope: "turn", runId, path: file.key })
            }
          >
            <Tag file={file} />
            <span className={styles.cardPath} title={file.display}>
              {file.display}
            </span>
            <FileStat file={file} />
          </button>
          <PopupMenu label={t("messages.actions")} icon="more">
            <RevealFileButton source={{ runId, path: file.key }} className={styles.revealItem} />
          </PopupMenu>
        </div>
      ))}
      {data.total > LISTED && (
        <p className={styles.cardMore}>
          {t("changes.card.more", { count: formatCount(data.total - LISTED) })}
        </p>
      )}
      {footer}
    </section>
  );
}
