import { Icon, type IconName } from "@pibot/ui";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { InPopupMenu } from "./menu-context.ts";
import styles from "./popup-menu.module.css";

/** A portal avoids clipping by the chat scroller; leaving the route releases all listeners. */
export function PopupMenu({
  label,
  children,
  icon = "menu",
  placement = "below",
  onOpenChange,
  disabled = false,
  showLabel = false,
}: {
  label: string;
  children: ReactNode;
  icon?: IconName;
  placement?: "above" | "below";
  onOpenChange?(open: boolean): void;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [position, setPosition] = useState<CSSProperties>(),
    id = useId();
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    notify.current?.(open);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(300, window.innerWidth - 24);
      const above = placement === "above";
      const room = above ? box.top - 16 : window.innerHeight - box.bottom - 16;
      setPosition({
        position: "fixed",
        width,
        left: Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12)),
        top: above ? undefined : box.bottom + 5,
        bottom: above ? window.innerHeight - box.top + 5 : undefined,
        maxHeight: Math.max(120, Math.min(window.innerHeight * 0.65, room)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, placement]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only first placement focuses; scrolling must not steal focus.
  useLayoutEffect(() => {
    if (open && position)
      panel.current
        ?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")
        ?.focus();
  }, [open, !!position]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <div className={styles.root}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        data-menu={icon === "menu" || undefined}
        data-labelled={showLabel || undefined}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name={icon} size={16} />
        {showLabel && <span>{label}</span>}
      </button>
      {open &&
        position &&
        createPortal(
          <div
            id={id}
            ref={panel}
            className={styles.menu}
            style={position}
            role="dialog"
            aria-label={label}
          >
            <InPopupMenu.Provider value={true}>{children}</InPopupMenu.Provider>
          </div>,
          document.body,
        )}
    </div>
  );
}
