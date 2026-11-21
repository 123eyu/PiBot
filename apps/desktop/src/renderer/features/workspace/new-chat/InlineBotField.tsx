import { botPanelStyles as styles, useT } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";

export function InlineBotField({
  label,
  value,
  maxLength,
  disabled,
  save,
  className,
  required = false,
  multiline = false,
  hint,
  requiredMessage,
  resetKey,
  placeholder,
}: {
  label: string;
  /** Hover tooltip that says the text can be edited in place. */
  hint?: string;
  requiredMessage?: string;
  resetKey?: string;
  placeholder?: string;
  value: string;
  maxLength: number;
  disabled: boolean;
  /**
   * `true` saved, `false` failed (the field goes back to the saved text), or a sentence that
   * explains why this text cannot be used (e.g. a taken name): it stays for the user to change.
   */
  save(value: string): Promise<boolean | string>;
  className?: string;
  required?: boolean;
  multiline?: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<false | true | string>(false);
  const baseline = useRef(value);
  const active = useRef(true);
  const locked = useRef(false);
  const version = useRef(0);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [refocus, setRefocus] = useState(false);
  const keepError = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      version.current++;
    };
  }, []);
  // The field is disabled while saving, which drops focus; after a refused name it comes back
  // (unless the user has moved on to something else) so Escape restores instead of closing.
  useEffect(() => {
    if (disabled || !refocus) return;
    setRefocus(false);
    if (document.activeElement && document.activeElement !== document.body) return;
    keepError.current = true;
    field.current?.focus();
  }, [disabled, refocus]);
  useEffect(() => {
    if (!editing && !locked.current) {
      baseline.current = value;
      setDraft(value);
    }
  }, [value, editing]);
  // Another successful profile edit supersedes feedback from the previous saved revision.
  useEffect(() => {
    void resetKey;
    setError(false);
  }, [resetKey]);
  const commit = async () => {
    if (locked.current) return;
    const text = draft.trim();
    if (text === baseline.current) {
      setError(false);
      setEditing(false);
      return;
    }
    if (required && !text) {
      setDraft(baseline.current);
      setError(requiredMessage ?? true);
      setEditing(false);
      return;
    }
    locked.current = true;
    const operation = ++version.current;
    const saved = await save(text);
    locked.current = false;
    if (active.current && operation === version.current) {
      if (typeof saved === "string") {
        // Keep the typed text (still editing) so it can be changed right away; Escape restores.
        setError(saved);
        setRefocus(true);
        return;
      }
      if (saved) baseline.current = text;
      setDraft(baseline.current);
      setError(!saved);
      setEditing(false);
    }
  };
  const props = {
    ref: (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      field.current = node;
    },
    "aria-label": label,
    title: editing ? undefined : hint,
    placeholder,
    "aria-invalid": typeof error === "string" || undefined,
    value: draft,
    maxLength,
    disabled,
    className: `${styles.inlineInput} ${className ?? ""}`,
    onFocus: () => {
      if (keepError.current) {
        keepError.current = false;
        return;
      }
      baseline.current = value;
      setEditing(true);
      setError(false);
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(event.currentTarget.value),
    onBlur: () => void commit(),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape") {
        if (draft === baseline.current && !locked.current) return;
        event.stopPropagation();
        setDraft(baseline.current);
        setEditing(false);
        setError(false);
        version.current++;
      } else if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void commit();
      }
    },
  };
  return (
    <>
      {multiline ? <textarea {...props} rows={6} /> : <input {...props} />}
      {error && (
        <span className={styles.error} role="alert">
          {typeof error === "string" ? error : t("workspace.failed")}
        </span>
      )}
    </>
  );
}
