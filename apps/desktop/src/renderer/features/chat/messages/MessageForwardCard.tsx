import { forwardCard } from "@pibot/client-core";
import { type Message, messageForward } from "@pibot/protocol";
import { useSettings } from "@pibot/renderer-kit";
import { Chip, Icon, IconTile } from "@pibot/ui";
import { useId, useState } from "react";
import chatStyles from "../chat.module.css";
import { Markdown } from "./Markdown.tsx";
import styles from "./message-forward.module.css";

/**
 * FORWARD-DISPLAY: the collapsed record under a forwarded message. The forwarded messages are
 * untrusted and stay plain text; only the handoff summary uses the reply Markdown renderer, which
 * skips raw HTML and opens http(s) links only.
 */
export function MessageForwardCard({ message }: { message: Message }) {
  const { t, language } = useSettings();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const forward = messageForward(message);
  if (!forward) return null;
  const card = forwardCard(forward, t, (at) =>
    new Date(at).toLocaleString(language, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  );
  const count = t("messages.forwardedCount", { count: forward.messageCount });
  // The shared title is "count · source"; the card shows them on their own lines.
  const source = card.title.startsWith(`${count} · `)
    ? card.title.slice(count.length + 3)
    : card.title;
  const files = forward.messages.flatMap((record) => record.attachments.map((a) => a.name));
  const toggle = (event: { stopPropagation(): void }) => {
    // The bubble's own click selects messages in selection mode; the card only toggles.
    event.stopPropagation();
    setOpen((value) => !value);
  };
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <IconTile icon="send" tone="pink" size="sm" />
        <strong className={styles.title}>{t("messages.forwardedTitle")}</strong>
        <span className={styles.count}>{count}</span>
      </div>
      <div className={styles.body}>
        <p className={styles.source}>{source}</p>
        {!open && (
          <p className={styles.preview}>
            {card.items.slice(0, 2).map((item) => (
              <span key={item.key}>
                <b>{item.sender}</b> {item.body}
              </span>
            ))}
          </p>
        )}
        <div id={bodyId} hidden={!open}>
          {open && (
            <>
              <ol className={styles.records}>
                {card.items.map((item) => (
                  <li key={item.key} className={styles.record}>
                    <div className={styles.meta}>
                      <strong>{item.sender}</strong>
                      <span>{item.time}</span>
                    </div>
                    {item.quote && <blockquote className={styles.quote}>{item.quote}</blockquote>}
                    {item.body && <p className={styles.text}>{item.body}</p>}
                  </li>
                ))}
              </ol>
              {card.truncatedNote && <p className={styles.notice}>{card.truncatedNote}</p>}
            </>
          )}
        </div>
        {!open && files.length > 0 && (
          <Chip className={styles.files}>
            {t("messages.forwardedAttachments", { names: files.join(", ") })}
          </Chip>
        )}
        {card.summary && (
          <section className={styles.summary} aria-label={card.summaryLabel}>
            <h4>{card.summaryLabel}</h4>
            <div className={`${chatStyles.bubble} ${styles.markdown}`}>
              <Markdown text={card.summary} messageId={message.id} settled />
            </div>
          </section>
        )}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${card.title} · ${t(open ? "messages.forwardedCollapse" : "messages.forwardedExpand")}`}
          onClick={toggle}
        >
          {t(open ? "messages.forwardedCollapse" : "messages.forwardedExpand")}
          <Icon
            name="chevron"
            size={13}
            style={{ transform: open ? "rotate(180deg)" : undefined }}
          />
        </button>
      </div>
    </div>
  );
}
