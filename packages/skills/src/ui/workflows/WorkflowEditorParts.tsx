import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { cloneElement, type ReactElement, type ReactNode, useId } from "react";
import styles from "./workflow.module.css";

export type InvalidField = (path: string) => boolean;

export function nextEditorId(prefix: string, values: readonly string[]): string {
  const used = new Set(values);
  for (let index = 1; index <= values.length + 1; index++) {
    const candidate = `${prefix}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix}-${values.length + 1}`;
}

export function EditorSection({
  title,
  add,
  children,
}: {
  title: string;
  add?: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section className={styles.editorSection}>
      <div className={styles.sectionTitle}>
        <h3>{title}</h3>
        {add && (
          <Button type="button" variant="ghost" onClick={add}>
            <Icon name="plus" size={14} />
            {t("workflows.editor.add")}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

export function EditorField({
  label,
  invalid,
  children,
}: {
  label: string;
  invalid?: boolean;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={styles.field} data-invalid={invalid || undefined}>
      <span>{label}</span>
      {cloneElement(children, { id })}
    </label>
  );
}

export function EditorRow({ remove, children }: { remove(): void; children: ReactNode }) {
  const t = useT();
  return (
    <div className={styles.editorRow}>
      {children}
      <Button
        type="button"
        variant="ghost"
        aria-label={t("workflows.editor.remove")}
        onClick={remove}
      >
        <Icon name="close" size={14} />
      </Button>
    </div>
  );
}
