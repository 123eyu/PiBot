import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useId, useState } from "react";
import styles from "./agents.module.css";

export function AgentTagInput({
  label,
  hint,
  value,
  change,
}: {
  label: string;
  hint: string;
  value: string;
  change(value: string): void;
}) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState("");
  const values = value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const add = () => {
    const additions = draft
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!additions.length) return;
    change([...values, ...additions].join("\n"));
    setDraft("");
  };
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.tags}>
        {values.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Duplicate literal entries have no persistent identity or local state.
          <span className={styles.tag} key={`${index}-${item}`}>
            {item}
            <Button
              variant="ghost"
              aria-label={t("attachments.remove", { name: item })}
              onClick={() => change(values.filter((_, i) => i !== index).join("\n"))}
            >
              <Icon name="close" size={12} />
            </Button>
          </span>
        ))}
      </div>
      <div className={styles.tagEntry}>
        <textarea
          rows={1}
          id={id}
          aria-describedby={`${id}-hint`}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          variant="secondary"
          aria-label={t("externalAgents.custom.addEntry")}
          disabled={!draft.trim()}
          onClick={add}
        >
          <Icon name="plus" size={16} />
        </Button>
      </div>
      <small id={`${id}-hint`}>{hint}</small>
    </div>
  );
}
