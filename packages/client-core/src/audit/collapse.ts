/**
 * A run of adjacent rows with the same repeat key, shown as one row with "×N" and the time
 * range. `rows` keep the input order (newest first in the records views), so `rows[0]` is the
 * newest and `rows.at(-1)` the oldest of the run.
 */
export interface RepeatGroup<T> {
  /** The first row's own key when it stands alone; stable across refreshes for expand state. */
  id: string;
  rows: T[];
}

/**
 * Collapses consecutive identical records (maintainers 2026-10-22: same kind, summary, Bot and
 * outcome, adjacent in time order). Only neighbours merge, so a different record in between
 * keeps both runs visible where they happened. `repeatKey` returns undefined for rows that must
 * never merge (e.g. ones still running, whose outcome is not final).
 */
export function collapseRepeats<T>(
  rows: readonly T[],
  rowId: (row: T) => string,
  repeatKey: (row: T) => string | undefined,
): RepeatGroup<T>[] {
  const groups: RepeatGroup<T>[] = [];
  let lastKey: string | undefined;
  for (const row of rows) {
    const key = repeatKey(row);
    const previous = groups.at(-1);
    if (previous && key !== undefined && key === lastKey) previous.rows.push(row);
    else groups.push({ id: rowId(row), rows: [row] });
    lastKey = key;
  }
  return groups;
}
