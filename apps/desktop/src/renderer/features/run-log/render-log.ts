import { cells, type LogIndex, type LogSnapshot } from "./index-log.ts";

export const MAX_VISIBLE_ROWS = 128;
export const MAX_ROW_CHARACTERS = 4096;
export const MAX_RENDER_CHARACTERS = 16_384;
// Checkpoints bound horizontal work even for one multi-megabyte Unicode line.
export function locate(
  index: LogIndex,
  text: string,
  line: number,
  value: number,
  byColumn: boolean,
) {
  let low = index.anchors[line - 1] ?? 0,
    high = index.anchors[line] ?? 0;
  const begin = low;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((index.points[mid * 2 + (byColumn ? 1 : 0)] ?? 0) <= value) low = mid + 1;
    else high = mid;
  }
  const anchor = Math.max(begin, low - 1);
  let cursor = index.points[anchor * 2] ?? 0,
    column = index.points[anchor * 2 + 1] ?? 0;
  while (
    cursor < text.length &&
    text[cursor] !== "\n" &&
    (byColumn ? column < value : cursor < value)
  ) {
    const code = text.codePointAt(cursor) ?? 0;
    column += cells(code, column);
    cursor += code > 0xffff ? 2 : 1;
  }
  return { cursor, column };
}
export function rowSlice(snapshot: LogSnapshot, row: number, left: number, columns: number) {
  const { index, text, wrap } = snapshot;
  const start = index.rows[row * 3] ?? 0,
    end = index.rows[row * 3 + 1] ?? 0,
    line = index.rows[row * 3 + 2] ?? 0;
  const clip = wrap ? { cursor: start, column: 0 } : locate(index, text, line, left, true);
  let from = Math.min(end, clip.cursor);
  if (from > start && /[\uDC00-\uDFFF]/.test(text[from] ?? "")) from--;
  // Bound every render independently of worker output, wrapping and viewport size.
  let to = Math.min(end, from + Math.min(MAX_ROW_CHARACTERS, columns));
  if (to < end && /[\uDC00-\uDFFF]/.test(text[to] ?? "")) to--;
  return { from, to, column: clip.column, line };
}
export function displayText(text: string, column: number) {
  const parts: string[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const width = cells(code, column);
    parts.push(code === 9 ? " ".repeat(width) : character);
    column += width;
  }
  return { text: parts.join(""), column };
}
