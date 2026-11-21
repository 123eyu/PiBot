import { Fragment, useMemo } from "react";
import styles from "./Combobox.module.css";
import type { ComboboxOption } from "./Combobox.tsx";

interface ComboboxListProps {
  id: string;
  labelId: string;
  options: readonly ComboboxOption[];
  value: string;
  active: ComboboxOption | undefined;
  onActiveChange(value: string): void;
  onSelect(option: ComboboxOption): void;
}

export function ComboboxList({
  id,
  labelId,
  options,
  value,
  active,
  onActiveChange,
  onSelect,
}: ComboboxListProps) {
  const groups = useMemo(() => {
    const result: { label: string | undefined; start: number; options: ComboboxOption[] }[] = [];
    for (const [index, option] of options.entries()) {
      const previous = result.at(-1);
      if (previous && previous.label === option.group) previous.options.push(option);
      else result.push({ label: option.group, start: index, options: [option] });
    }
    return result;
  }, [options]);
  return (
    <div id={id} role="listbox" aria-labelledby={labelId} className={styles.list}>
      {groups.map((group) => {
        const children = group.options.map((option) => (
          <button
            key={option.value}
            id={`${id}-${encodeURIComponent(option.value)}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            disabled={option.disabled}
            title={option.title ?? [option.label, option.secondary].filter(Boolean).join(" · ")}
            data-active={option === active}
            className={styles.option}
            onPointerMove={() => {
              if (!option.disabled) onActiveChange(option.value);
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(option)}
          >
            {option.leading && <span className={styles.leading}>{option.leading}</span>}
            <span className={`${styles.primary} ${option.muted ? styles.placeholder : ""}`}>
              {option.label}
            </span>
            {option.secondary && <span className={styles.secondary}>{option.secondary}</span>}
          </button>
        ));
        return group.label ? (
          <fieldset key={group.start} className={styles.group}>
            <legend className={styles.groupTitle}>{group.label}</legend>
            {children}
          </fieldset>
        ) : (
          <Fragment key={group.start}>{children}</Fragment>
        );
      })}
    </div>
  );
}
