import { type KeyboardEvent, type Ref, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DatePickerLabels } from "./DatePicker.tsx";
import { clockText } from "./date-math.ts";
import styles from "./date-picker.module.css";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const STEPS = Array.from({ length: 12 }, (_, index) => index * 5);
const QUICK = [
  [9, 0],
  [12, 0],
  [18, 0],
] as const;
const pad = (value: number) => String(value).padStart(2, "0");

/**
 * 24-hour time: the big HH:MM is two typed segments (exact minutes such as 08:37 are accepted),
 * the columns offer the hours and 5-minute steps, and the chips cover the usual times.
 */
export function TimeColumn({
  hour,
  minute,
  set,
  done,
  labels,
  autoFocus,
}: {
  hour?: number;
  minute?: number;
  set(hour: number, minute: number): void;
  done(): void;
  labels: DatePickerLabels;
  autoFocus: boolean;
}) {
  const titleId = useId();
  // A typed off-step minute (08:37) joins the list so the column can still show the choice.
  const minutes = useMemo(
    () =>
      minute === undefined || minute % 5 === 0 ? STEPS : [...STEPS, minute].sort((a, b) => a - b),
    [minute],
  );
  const hourInput = useRef<HTMLInputElement>(null);
  const minuteInput = useRef<HTMLInputElement>(null);
  // Passive effects run after the host's layout effect has shown the (display: none) popover.
  useEffect(() => {
    if (autoFocus) hourInput.current?.focus();
  }, [autoFocus]);
  const h = hour ?? 9;
  const m = minute ?? 0;
  return (
    <section className={styles.time} aria-labelledby={titleId}>
      <div id={titleId} className={styles.timeTitle}>
        {labels.time}
      </div>
      <div className={styles.timeBig}>
        <Segment
          ref={hourInput}
          label={labels.hour}
          value={hour}
          max={23}
          commit={(value) => set(value, m)}
          advance={() => minuteInput.current?.focus()}
          done={done}
        />
        <span aria-hidden="true">:</span>
        <Segment
          ref={minuteInput}
          label={labels.minute}
          value={minute}
          max={59}
          commit={(value) => set(h, value)}
          done={done}
        />
      </div>
      <div className={styles.columns}>
        <Column
          label={labels.hour}
          items={HOURS}
          value={hour}
          choose={(value) => set(value, m)}
          done={done}
        />
        <Column
          label={labels.minute}
          items={minutes}
          value={minute}
          choose={(value) => set(h, value)}
          done={done}
        />
      </div>
      <div className={styles.timeChips}>
        {QUICK.map(([qh, qm]) => (
          <button
            key={qh}
            type="button"
            className={styles.chip}
            aria-pressed={hour === qh && minute === qm}
            onClick={() => set(qh, qm)}
          >
            {clockText(qh, qm)}
          </button>
        ))}
      </div>
    </section>
  );
}

function Segment({
  ref,
  label,
  value,
  max,
  commit,
  advance,
  done,
}: {
  ref: Ref<HTMLInputElement>;
  label: string;
  value?: number;
  max: number;
  commit(value: number): void;
  advance?(): void;
  done(): void;
}) {
  const [draft, setDraftState] = useState<string>();
  // Mirrors the state synchronously: auto-advance blurs this input before React re-renders, and
  // the blur must not commit the stale one-digit draft over the value just saved.
  const pending = useRef<string>(undefined);
  const setDraft = (text: string | undefined) => {
    pending.current = text;
    setDraftState(text);
  };
  const save = (text: string | undefined) => {
    setDraft(undefined);
    if (!text) return;
    const next = Number(text);
    if (next <= max) commit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save(pending.current);
      done();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = ((value ?? 0) + (event.key === "ArrowUp" ? 1 : -1) + max + 1) % (max + 1);
      setDraft(undefined);
      commit(next);
    }
  };
  return (
    <input
      ref={ref}
      aria-label={label}
      inputMode="numeric"
      autoComplete="off"
      className={styles.segment}
      value={draft ?? (value === undefined ? "--" : pad(value))}
      // Selecting shows that typing replaces the segment; onChange enforces it either way, so
      // there is no maxLength to refuse a digit typed after the caret.
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.currentTarget.select()}
      onBlur={() => save(pending.current)}
      onKeyDown={onKeyDown}
      onChange={(event) => {
        // Typing over a shown value starts a fresh entry wherever the caret is: Chromium does not
        // keep a select() made while focus is moved programmatically by auto-advance.
        const typed = (event.nativeEvent as InputEvent).data;
        const raw = pending.current === undefined && typed ? typed : event.currentTarget.value;
        const text = raw.replace(/\D/g, "").slice(0, 2);
        // A second digit, or a first digit that cannot start a valid two-digit value, completes it.
        if (text.length === 2 || (text.length === 1 && Number(text) * 10 > max)) {
          save(text);
          advance?.();
        } else setDraft(text);
      }}
    />
  );
}

function Column({
  label,
  items,
  value,
  choose,
  done,
}: {
  label: string;
  items: readonly number[];
  value?: number;
  choose(value: number): void;
  done(): void;
}) {
  const list = useRef<HTMLFieldSetElement>(null);
  const placed = useRef(false);
  useEffect(() => {
    const element = list.current?.children[items.indexOf(value ?? -1)] as HTMLElement | undefined;
    if (!list.current || !element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.current.scrollTo({
      top: element.offsetTop - list.current.clientHeight / 2 + element.offsetHeight / 2,
      // The first placement must not animate from the top of the list when the popover opens.
      behavior: placed.current && !reduce ? "smooth" : "auto",
    });
    placed.current = true;
  }, [items, value]);
  const fallback = items.includes(value ?? -1) ? value : items[0];
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[index];
      if (item !== undefined) choose(item);
      done();
      return;
    }
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(items.length - 1, index + step));
    const item = items[next];
    if (item === undefined) return;
    choose(item);
    (list.current?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <fieldset ref={list} aria-label={label} className={styles.column}>
      {items.map((item, index) => (
        <button
          key={item}
          type="button"
          tabIndex={item === fallback ? 0 : -1}
          aria-pressed={item === value}
          onClick={() => choose(item)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {pad(item)}
        </button>
      ))}
    </fieldset>
  );
}
