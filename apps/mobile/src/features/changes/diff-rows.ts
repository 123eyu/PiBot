import type { ChangesDiff } from "@pibot/protocol";

export type DiffRow =
  | { type: "gap"; key: string; from: number; count: number }
  | { type: "hunk"; key: string; text: string }
  | {
      type: "line";
      key: string;
      sign: " " | "+" | "-" | "\\";
      text: string;
      oldNo?: number;
      newNo?: number;
    };
/** Lines expanded into a gap, keyed by the gap's first newer-side line. */
export type Expanded = Record<number, string[]>;

/**
 * Flattens hunks into list rows with line numbers; the unchanged stretches before and between
 * hunks become "gap" rows that can be expanded with changes.lines (newer side).
 */
export function diffRows(diff: ChangesDiff, expanded: Expanded): DiffRow[] {
  const rows: DiffRow[] = [];
  let nextNew = 1;
  const gap = (start: number, end: number, shift: number) => {
    // `shift` maps a newer-side line to the older side across an unchanged stretch.
    let line = start;
    for (const [from, lines] of Object.entries(expanded).map(([k, v]) => [Number(k), v] as const)) {
      if (from !== line || from > end) continue;
      for (const text of lines.slice(0, end - line + 1)) {
        rows.push({
          type: "line",
          key: `e${line}`,
          sign: " ",
          text,
          oldNo: line - shift,
          newNo: line,
        });
        line++;
      }
    }
    if (line <= end) rows.push({ type: "gap", key: `g${line}`, from: line, count: end - line + 1 });
  };
  for (const hunk of diff.hunks) {
    if (hunk.newStart > nextNew) gap(nextNew, hunk.newStart - 1, hunk.newStart - hunk.oldStart);
    rows.push({ type: "hunk", key: `h${hunk.index}`, text: hunk.header });
    let oldNo = hunk.oldStart,
      newNo = hunk.newStart;
    hunk.lines.forEach((raw, i) => {
      const sign = (raw[0] ?? " ") as " " | "+" | "-" | "\\";
      const key = `h${hunk.index}:${i}`;
      const text = raw.slice(1);
      if (sign === "+") rows.push({ type: "line", key, sign, text, newNo: newNo++ });
      else if (sign === "-") rows.push({ type: "line", key, sign, text, oldNo: oldNo++ });
      else if (sign === "\\") rows.push({ type: "line", key, sign, text });
      else rows.push({ type: "line", key, sign: " ", text, oldNo: oldNo++, newNo: newNo++ });
    });
    nextNew = hunk.newStart + hunk.newLines;
  }
  return rows;
}
