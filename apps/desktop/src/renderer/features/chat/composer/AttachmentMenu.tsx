import { IconButton } from "@pibot/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "./attachments.module.css";

interface MenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  select(): void;
}

export function AttachmentMenu({
  label,
  disabled,
  items,
}: {
  label: string;
  disabled: boolean;
  items: MenuItem[];
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const firstFocus = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const open = expanded && !disabled;
  const close = (restoreFocus = false) => {
    setExpanded(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = (index = 0) => {
    firstFocus.current = index;
    if (open) buttons.current[index]?.focus();
    else setExpanded(true);
  };
  useLayoutEffect(() => {
    if (open) buttons.current[firstFocus.current]?.focus();
  }, [open]);
  useEffect(() => {
    if (disabled) setExpanded(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      // Continue native tab order from the trigger after removing the popup.
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      buttons.current[next]?.focus();
    }
  };
  return (
    <div ref={root} className={styles.menuAnchor}>
      <IconButton
        ref={trigger}
        label={label}
        disabled={disabled}
        className={styles.add}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowUp" ? items.length - 1 : 0);
          }
        }}
      >
        <svg
          aria-hidden="true"
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </IconButton>
      {open && (
        <div id={id} role="menu" aria-label={label} className={styles.menu} onKeyDown={navigate}>
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(button) => {
                buttons.current[index] = button;
              }}
              type="button"
              role="menuitem"
              tabIndex={active === index ? 0 : -1}
              className={styles.menuItem}
              onFocus={() => setActive(index)}
              onClick={() => {
                close(true);
                item.select();
              }}
            >
              <span aria-hidden="true" className={styles.menuIcon}>
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
