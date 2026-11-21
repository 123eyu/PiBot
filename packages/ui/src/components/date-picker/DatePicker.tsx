import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../Icon.tsx";
import type { Tone } from "../lively.tsx";
import { Calendar } from "./Calendar.tsx";
import {
  type DatePickerMode,
  dayKey,
  formatValue,
  parseValue,
  today,
  valueText,
  withinRange,
} from "./date-math.ts";
import styles from "./date-picker.module.css";
import { TimeColumn } from "./TimeColumn.tsx";

export type { DatePickerMode };

/** Every visible word; `@pibot/ui` has no translator, so the caller passes them localized. */
export interface DatePickerLabels {
  placeholder: string;
  previousMonth: string;
  nextMonth: string;
  today: string;
  tomorrow: string;
  nextMonday: string;
  clear: string;
  time: string;
  hour: string;
  minute: string;
}

export interface DatePickerProps {
  /** `date` → `YYYY-MM-DD`, `datetime` → `YYYY-MM-DDTHH:MM`, `time` → `HH:MM`, all local. */
  mode?: DatePickerMode;
  /** Accessible name of the field and the popover (the visible label stays the caller's). */
  label: string;
  value: string;
  onValueChange(value: string): void;
  labels: DatePickerLabels;
  /** BCP 47 locale for month, weekday and field text. */
  locale: string;
  weekStartsOn?: 0 | 1;
  /** Inclusive day bounds in the same string format; only the date part is enforced. */
  min?: string;
  max?: string;
  /** Blocks form submission while empty, as the native input's `required` did. */
  required?: boolean;
  /** Defaults to optional fields: a ✕ in the field and a 清除 chip. */
  clearable?: boolean;
  disabled?: boolean;
  /** The host surface's colour; without it the popover uses `--page-c` / `--accent-ink`. */
  tone?: Tone;
  /** `tinted` is the routines editor's large accent-washed time look. */
  appearance?: "field" | "tinted";
  id?: string;
}

function toneStyle(tone: Tone | undefined) {
  if (!tone || tone === "neutral") return undefined;
  const fill = tone === "red" ? "var(--danger)" : `var(--avatar-${tone})`;
  const ink = tone === "red" ? "var(--danger)" : `var(--ink-${tone})`;
  return { "--dp-c": fill, "--dp-ink": ink } as CSSProperties;
}

// Invisible but still a real form control, so the browser's constraint validation sees it.
const PROXY: CSSProperties = {
  position: "absolute",
  left: 0,
  bottom: 0,
  width: 1,
  height: 1,
  padding: 0,
  border: 0,
  opacity: 0,
  pointerEvents: "none",
};

export function DatePicker({
  mode = "date",
  label,
  value,
  onValueChange,
  labels,
  locale,
  weekStartsOn = 1,
  min,
  max,
  required = false,
  clearable = !required,
  disabled = false,
  tone,
  appearance = "field",
  id,
}: DatePickerProps) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const labelId = `${triggerId}-label`;
  const valueId = `${triggerId}-value`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [now, setNow] = useState(today);
  const [active, setActive] = useState(now);
  const shown = open && !disabled;
  const parts = parseValue(mode, value);
  const text = valueText(mode, parts, locale, now);
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = () => {
    // Re-read today on every open: the app stays running across midnight.
    const day = today();
    setNow(day);
    // An empty field opens on today, or on the nearest allowed day when today is out of range.
    const bound = min && dayKey(day) < min.slice(0, 10) ? min : max;
    const start = withinRange(day, min, max) ? day : parseValue("date", bound ?? "").day;
    setActive(parts.day ?? start ?? day);
    setOpen(true);
  };
  const change = (next: string) => {
    setInvalid(false);
    onValueChange(next);
  };
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  // Declared before the position hook: a manual popover is display: none until shown, and the
  // card has to be laid out before it can be measured.
  useLayoutEffect(() => {
    if (shown && popup.current?.hasAttribute("popover")) popup.current.showPopover();
  }, [shown]);
  const position = usePopupPosition(shown, trigger, popup);
  useEffect(() => {
    if (!shown) return;
    const dismiss = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !trigger.current?.parentElement?.contains(target) &&
        !popup.current?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [shown]);
  const onPopupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Stops the host <dialog> from treating the same Esc as its own cancel.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      event.stopPropagation();
      trapTab(event, popup.current);
    }
  };
  const pickDay = (day: Date) => {
    if (mode === "date") {
      change(dayKey(day));
      close(true);
      return;
    }
    setActive(day);
    change(formatValue(mode, { ...parts, day }, now));
  };
  const host = trigger.current?.closest("dialog, [data-panel-focus-boundary]");
  return (
    <div
      className={styles.root}
      data-appearance={appearance}
      data-open={shown || undefined}
      style={toneStyle(tone)}
    >
      <span id={labelId} hidden>
        {label}
      </span>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className={styles.trigger}
        data-clearable={(clearable && !!value) || undefined}
        aria-haspopup="dialog"
        aria-expanded={shown}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (shown ? close(true) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !shown) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span
          id={valueId}
          className={text ? styles.value : `${styles.value} ${styles.placeholder}`}
        >
          {text ?? labels.placeholder}
        </span>
        <Icon name={mode === "time" ? "clock" : "calendar"} size={17} className={styles.icon} />
      </button>
      {clearable && value && (
        <button
          type="button"
          className={styles.clear}
          aria-label={labels.clear}
          title={labels.clear}
          disabled={disabled}
          onClick={() => {
            change("");
            close(true);
          }}
        >
          <Icon name="close" size={11} />
        </button>
      )}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          required
          value={value}
          disabled={disabled}
          style={PROXY}
          onChange={() => undefined}
          onInvalid={(event) => {
            // The native bubble speaks the OS language, the very mismatch this picker replaces;
            // mark the field and hand focus to it instead.
            event.preventDefault();
            setInvalid(true);
            trigger.current?.focus();
          }}
        />
      )}
      {shown &&
        createPortal(
          <div
            ref={popup}
            role="dialog"
            aria-label={label}
            popover={host?.tagName === "DIALOG" ? "manual" : undefined}
            className={styles.popup}
            style={{ ...position, ...toneStyle(tone) }}
            onKeyDown={onPopupKeyDown}
          >
            {mode !== "time" && (
              <Calendar
                active={active}
                setActive={setActive}
                selected={parts.day}
                now={now}
                locale={locale}
                weekStartsOn={weekStartsOn}
                min={min}
                max={max}
                labels={labels}
                clearable={clearable && mode === "date"}
                pick={pickDay}
                clear={() => {
                  change("");
                  close(true);
                }}
              />
            )}
            {mode !== "date" && (
              <TimeColumn
                hour={parts.hour}
                minute={parts.minute}
                labels={labels}
                autoFocus={mode === "time"}
                set={(hour, minute) => change(formatValue(mode, { ...parts, hour, minute }, now))}
                done={() => close(true)}
              />
            )}
          </div>,
          // Inside a modal the popover must stay in the dialog's top layer and focus boundary.
          host ?? document.body,
        )}
    </div>
  );
}

function trapTab(event: KeyboardEvent<HTMLDivElement>, root: HTMLElement | null) {
  if (!root) return;
  const focusables = [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled)',
    ),
  ];
  const first = focusables[0];
  const last = focusables.at(-1);
  if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
}

// Transparent rather than visibility: hidden, which would refuse the focus the calendar's
// effect hands to the active day before the measured position lands.
const UNPLACED: CSSProperties = { opacity: 0, pointerEvents: "none" };

// Below this much room a scrolling card would hide most of the month; flipping up reads better.
const MODAL_MIN_BELOW = 260;

/**
 * Below the field, or above when it does not fit; measured so the card never leaves the window.
 * Inside a modal dialog, flipping up covered the dialog's own header and first fields and looked
 * detached from the field (docs guide 2026-11-14, New to-do); there the card stays below and
 * scrolls when the window is short, as long as a usable part of the month fits.
 */
function usePopupPosition(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  popup: RefObject<HTMLElement | null>,
) {
  const [position, setPosition] = useState<CSSProperties>(UNPLACED);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(UNPLACED);
      return;
    }
    const update = () => {
      if (!trigger.current || !popup.current) return;
      const field = trigger.current.getBoundingClientRect();
      const card = popup.current.getBoundingClientRect();
      // The natural height, also while a max-height below makes the card scroll: measuring the
      // clipped box would flip the decision back and forth on every resize.
      const height = Math.max(card.height, popup.current.scrollHeight);
      const margin = 8;
      const gap = 6;
      const below = window.innerHeight - field.bottom - gap - margin;
      const left = Math.max(margin, Math.min(field.left, window.innerWidth - card.width - margin));
      const modal = !!trigger.current.closest("dialog");
      if (modal && below < height && below >= MODAL_MIN_BELOW) {
        setPosition({ left, top: field.bottom + gap, maxHeight: below, overflowY: "auto" });
        return;
      }
      const upward = below < height && field.top - gap - margin > below;
      setPosition({
        left,
        top: Math.max(
          margin,
          upward
            ? field.top - gap - height
            : Math.min(field.bottom + gap, window.innerHeight - height - margin),
        ),
      });
    };
    update();
    // Capture ancestor scrolling too: the portal does not share the field's scroll container.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    if (popup.current) observer.observe(popup.current);
    if (trigger.current) observer.observe(trigger.current);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [open, trigger, popup]);
  return position;
}
