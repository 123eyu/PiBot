import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../changes.module.css";
import { type CommentAnchor, commentRef, type DraftComment } from "./comments.ts";

export function CommentCard({
  comment,
  onDelete,
  inline,
}: {
  comment: DraftComment;
  onDelete(id: string): void;
  inline?: boolean;
}) {
  const t = useT();
  return (
    <div className={styles.comment} data-inline={inline || undefined}>
      <div className={styles.commentHead}>
        <b>{t("changes.comment.mine")}</b>
        <span className={styles.commentRef}>{commentRef(t, comment)}</span>
        <span className={styles.commentState}>{t("changes.comment.pending")}</span>
      </div>
      <p className={styles.commentText}>{comment.text}</p>
      <div className={styles.commentActions}>
        <button type="button" className={styles.miniGhost} onClick={() => onDelete(comment.id)}>
          {t("changes.comment.delete")}
        </button>
      </div>
    </div>
  );
}

export function CommentEditor({
  anchor,
  botName,
  onSave,
  onCancel,
  inline,
}: {
  anchor: CommentAnchor;
  botName: string;
  onSave(text: string): void;
  onCancel(): void;
  inline?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus({ preventScroll: false }), []);
  return (
    <div className={styles.comment} data-inline={inline || undefined}>
      <div className={styles.commentHead}>
        <b>{t("changes.comment.write")}</b>
        <span className={styles.commentRef}>{commentRef(t, anchor)}</span>
        {anchor.side === "new" && anchor.from === anchor.to && (
          <span className={styles.commentState}>{t("changes.comment.shiftHint")}</span>
        )}
      </div>
      <textarea
        ref={area}
        className={styles.textarea}
        rows={2}
        aria-label={t("changes.comment.write")}
        placeholder={t("changes.comment.placeholder", { name: botName })}
        value={text}
        maxLength={4000}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim()) {
            event.preventDefault();
            onSave(text);
          }
        }}
      />
      <div className={styles.commentActions}>
        <button type="button" className={styles.miniGhost} onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <Button
          className={styles.smallPrimary}
          disabled={!text.trim()}
          onClick={() => onSave(text)}
        >
          {t("changes.comment.add")}
        </Button>
      </div>
    </div>
  );
}
