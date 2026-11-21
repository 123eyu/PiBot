import type { Message } from "@pibot/protocol";
import { RevealFileButton, useT } from "@pibot/renderer-kit";
import styles from "../chat.module.css";

/** The brain's record of files a reply left out at the per-reply limit (maintainers 2026-11-20). */
function overflowOf(usage: Message["usage"]) {
  const record =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? usage.attachmentOverflow
      : undefined;
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const { count, folder } = record;
  return typeof count === "number" && count > 0 && typeof folder === "string"
    ? { count, folder }
    : undefined;
}

/** No file a run produced goes unmentioned: the ones past the limit are counted with their folder. */
export function MessageAttachmentOverflow({
  message,
  readOnly = false,
}: {
  message: Message;
  readOnly?: boolean;
}) {
  const t = useT();
  const overflow = overflowOf(message.usage);
  if (!overflow) return null;
  return (
    <div className={styles.attachmentOverflow} role="note">
      <span>{t("chat.attachmentOverflow", overflow)}</span>
      {!readOnly && <RevealFileButton source={{ overflowMessageId: message.id }} compact />}
    </div>
  );
}
