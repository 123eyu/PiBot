/**
 * Personal to-do calendar dates, shared by the desktop inbox calendar and the phone's To-dos tab
 * so both place a to-do on the same days. Days are local `YYYY-MM-DD` keys; a timed deadline
 * keeps the wall time and offset the editor wrote.
 */
export interface CalendarTodo {
  dueAt: string | null;
  endAt?: string | null;
}

export function dayKey(date: Date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

// Noon keeps a day key on the same date across a daylight-saving shift.
export function dayDate(key: string) {
  return new Date(`${key}T12:00:00`);
}

export function shiftDay(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function dueIsPast(dueAt: string, endAt?: string | null) {
  const deadline = endAt ?? dueAt;
  return deadline.length === 10 ? deadline < dayKey(new Date()) : Date.parse(deadline) < Date.now();
}

/** The editor writes a timed deadline in local time with its offset; show that wall time, not ISO. */
export function dueText(dueAt: string) {
  return dueAt.length > 10 ? `${dueAt.slice(0, 10)} ${dueAt.slice(11, 16)}` : dueAt;
}

/** A timed deadline as the editors write it: local wall time with the local offset. */
export function localDeadline(date: string, time: string) {
  const offset = -new Date(`${date}T${time}`).getTimezoneOffset();
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date}T${time}:00${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function todoOnDay(todo: CalendarTodo, day: string) {
  const start = todo.dueAt?.slice(0, 10);
  return !!start && start <= day && day <= (todo.endAt ?? start);
}

/** The weeks shown for a month (`YYYY-MM`), Sunday first, whole weeks only. */
export function monthDays(month: string) {
  const first = dayDate(`${month}-01`);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12);
  const gridStart = shiftDay(first, -first.getDay());
  return Array.from({ length: 7 * Math.ceil((first.getDay() + last.getDate()) / 7) }, (_, i) =>
    shiftDay(gridStart, i),
  );
}

export function shiftMonth(month: string, delta: number) {
  const first = dayDate(`${month}-01`);
  return dayKey(new Date(first.getFullYear(), first.getMonth() + delta, 1, 12)).slice(0, 7);
}

/**
 * Reserves the same lane across one visible week before drawing any day, so a multi-day to-do
 * stays one straight bar; `count` is every to-do on that day, laned or not.
 */
export function weekLanes<T extends CalendarTodo>(days: string[], todos: readonly T[], lanes = 2) {
  const placements = days.map(() => ({
    lanes: Array<T | undefined>(lanes).fill(undefined),
    count: 0,
  }));
  const indexes = Array.from({ length: lanes }, (_, index) => index);
  for (const todo of todos) {
    const occupied = placements.filter((_, index) => todoOnDay(todo, days[index] as string));
    if (!occupied.length) continue;
    for (const slot of occupied) slot.count++;
    const lane = indexes.find((index) => occupied.every((slot) => !slot.lanes[index]));
    if (lane !== undefined) for (const slot of occupied) slot.lanes[lane] = todo;
  }
  return placements;
}
