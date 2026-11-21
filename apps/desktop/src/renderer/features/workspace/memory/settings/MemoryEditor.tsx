import type { Memory } from "@pibot/protocol";
import { AppSelect, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./memory-settings.module.css";

export function MemoryEditor({
  initial,
  busy,
  save,
  cancel,
}: {
  initial?: Pick<Memory, "text" | "category">;
  busy: boolean;
  save(text: string, category: Memory["category"]): Promise<boolean>;
  cancel(): void;
}) {
  const t = useT();
  const [text, setText] = useState(initial?.text ?? "");
  const [category, setCategory] = useState<Memory["category"]>(initial?.category ?? null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const disabled =
    busy || !text.trim() || text.includes("\0") || Array.from(text.trim()).length > 8000;
  return (
    <form
      className={styles.edit}
      data-memory-editor
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled)
          void save(text.trim(), category).then((ok) => {
            if (ok) cancel();
          });
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) cancel();
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          if (!disabled) event.currentTarget.requestSubmit();
        }
      }}
    >
      <textarea
        ref={input}
        className={styles.editor}
        aria-label={t("memorySettings.text")}
        maxLength={16000}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
      />
      <div className={styles.editorActions}>
        <AppSelect
          label={t("memorySettings.category")}
          value={category ?? "other"}
          disabled={busy}
          options={(["about_you", "work", "how_to", "other"] as const).map((value) => ({
            value,
            label: t(`workspace.category.${value}`),
          }))}
          change={(value) =>
            setCategory(value === "other" ? null : (value as NonNullable<Memory["category"]>))
          }
        />
        <div className={styles.toolbar}>
          <Button variant="ghost" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" className={styles.save} disabled={disabled}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
