import { type KeyboardEvent, useEffect, useId, useMemo, useRef } from "react";
import { Icon } from "../Icon.tsx";
import type { DatePickerLabels } from "./DatePicker.tsx";
import {
  addDays,
  addMonths,
  dayKey,
  fullDayLabel,
  monthGrid,
  monthTitle,
  nextMonday,
  sameDay,
  weekdayHeads,
  withinRange,
} from "./date-math.ts";
import styles from "./date-picker.module.css";

const STEPS: Record<string, (date: Date, weekStartsOn: 0 | 1, shift: boolean) => Date> = {
  ArrowLeft: (date) => addDays(date, -1),
  ArrowRight: (date) => addDays(date, 1),
  ArrowUp: (date) => addDays(date, -7),
  ArrowDown: (date) => addDays(date, 7),
  Home: (date, start) => addDays(date, -((date.getDay() - start + 7) % 7)),
  End: (date, start) => addDays(date, 6 - ((date.getDay() - start + 7) % 7)),
  PageUp: (date, _, shift) => addMonths(date, shift ? -12 : -1),
  PageDown: (date, _, shift) => addMonths(date, shift ? 12 : 1),
};

/**
 * The month grid follows the APG date-picker dialog: one roving tab stop on the active day, arrows
 * and PageUp/PageDown move it, and the view month is always the active day's month, so the grid,
 * header and keyboard can never disagree about which month is shown.
 */
export function Calendar({
  active,
  setActive,
  selected,
  now,
  locale,
  weekStartsOn,
  min,
  max,
  labels,
  clearable,
  pick,
  clear,
}: {
  active: Date;
  setActive(date: Date): void;
  selected?: Date;
  now: Date;
  locale: string;
  weekStartsOn: 0 | 1;
  min?: string;
  max?: string;
  labels: DatePickerLabels;
  clearable: boolean;
  pick(date: Date): void;
  clear(): void;
}) {
  const titleId = useId();
  const grid = useRef<HTMLTableElement>(null);
  const moveFocus = useRef(true);
  const weeks = useMemo(() => monthGrid(active, weekStartsOn), [active, weekStartsOn]);
  const heads = useMemo(() => weekdayHeads(locale, weekStartsOn), [locale, weekStartsOn]);
  // Passive, so it runs after the host has shown its popover; a hidden button cannot take focus.
  useEffect(() => {
    // Only keyboard moves (and opening) pull focus; a pointer on the month buttons keeps it there.
    if (!moveFocus.current) return;
    moveFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>('[data-active="true"]')?.focus();
  });
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const step = STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    moveFocus.current = true;
    setActive(step(active, weekStartsOn, event.shiftKey));
  };
  const chips = [
    { label: labels.today, date: now },
    { label: labels.tomorrow, date: addDays(now, 1) },
    { label: labels.nextMonday, date: nextMonday(now) },
  ];
  const nowKey = dayKey(now);
  return (
    <div className={styles.calendar}>
      <div className={styles.monthHeader}>
        <b id={titleId} aria-live="polite">
          {monthTitle(active, locale)}
        </b>
        <div className={styles.nav}>
          <button
            type="button"
            aria-label={labels.previousMonth}
            title={labels.previousMonth}
            onClick={() => setActive(addMonths(active, -1))}
          >
            <Icon name="back" size={16} />
          </button>
          <button
            type="button"
            aria-label={labels.nextMonth}
            title={labels.nextMonth}
            onClick={() => setActive(addMonths(active, 1))}
          >
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
      </div>
      <table
        ref={grid}
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the WAI-ARIA APG date picker is a table with role="grid"; each cell's day button takes the roving focus.
        role="grid"
        aria-labelledby={titleId}
        className={styles.grid}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {heads.map((head) => (
              <th
                key={head.long}
                scope="col"
                abbr={head.long}
                className={styles.weekday}
                data-weekend={head.weekend || undefined}
              >
                {head.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={dayKey(week[0] ?? active)}>
              {week.map((date) => {
                const key = dayKey(date);
                const enabled = withinRange(date, min, max);
                const isActive = sameDay(date, active);
                const isSelected = sameDay(date, selected);
                return (
                  // biome-ignore lint/a11y: APG grid cell; it carries aria-selected and its day button takes the focus.
                  <td key={key} role="gridcell" aria-selected={isSelected}>
                    <button
                      type="button"
                      tabIndex={isActive ? 0 : -1}
                      className={styles.day}
                      data-active={isActive || undefined}
                      data-outside={date.getMonth() !== active.getMonth() || undefined}
                      data-past={key < nowKey || undefined}
                      data-today={key === nowKey || undefined}
                      data-selected={isSelected || undefined}
                      aria-current={key === nowKey ? "date" : undefined}
                      aria-disabled={!enabled || undefined}
                      aria-label={fullDayLabel(date, locale)}
                      onClick={() => {
                        // Out-of-range days stay focusable so arrow keys can pass through them.
                        if (enabled) pick(date);
                        else setActive(date);
                      }}
                    >
                      {date.getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.quick}>
        {chips.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={styles.chip}
            disabled={!withinRange(chip.date, min, max)}
            onClick={() => pick(chip.date)}
          >
            {chip.label}
          </button>
        ))}
        {clearable && (
          <button type="button" className={`${styles.chip} ${styles.ghost}`} onClick={clear}>
            {labels.clear}
          </button>
        )}
      </div>
    </div>
  );
}
