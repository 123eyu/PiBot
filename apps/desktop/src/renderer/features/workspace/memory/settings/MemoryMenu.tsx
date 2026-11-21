import { Icon } from "@pibot/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./memory-settings.module.css";

/** Stay inside the owning dialog's native modal focus and pointer boundaries. */
export function MemoryMenu({
  label,
  children,
  above = false,
  compact = false,
}: {
  label: string;
  children: ReactNode;
  above?: boolean;
  compact?: boolean;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && root.current)
        root.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <details
      ref={root}
      className={styles.menu}
      data-above={above || undefined}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && root.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          root.current.open = false;
          root.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={label}>{compact ? <Icon name="more" size={16} /> : label}</summary>
      <fieldset
        className={styles.menuItems}
        onKeyDown={(event) => {
          if (event.key === "Escape" && root.current) {
            event.preventDefault();
            event.stopPropagation();
            root.current.open = false;
            root.current.querySelector("summary")?.focus();
          }
        }}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button") && root.current)
            root.current.open = false;
        }}
        aria-label={label}
      >
        {children}
      </fieldset>
    </details>
  );
}
