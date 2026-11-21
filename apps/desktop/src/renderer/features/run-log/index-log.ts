export interface LogIndex {
  rows: Uint32Array;
  matches: Uint32Array;
  columns: number;
  points: Uint32Array;
  anchors: Uint32Array;
}
export interface LogSnapshot {
  text: string;
  query: string;
  wrap: number;
  revision: number;
  index: LogIndex;
}
export function lowerBound(values: Uint32Array, value: number) {
  let low = 0,
    high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((values[mid] ?? 0) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}
export function retainedMatch(previous: LogSnapshot, active: number, next: LogSnapshot) {
  const offset = previous.index.matches[active];
  return previous.query === next.query && offset !== undefined
    ? Math.max(0, Math.min(next.index.matches.length - 1, lowerBound(next.index.matches, offset)))
    : 0;
}
export function cells(code: number, column: number) {
  if (code === 9) return 2 - (column % 2);
  return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 2 : 1;
}
/** Runs in a worker: indexing and millions of matches never block the renderer. */
export function indexLog(text: string, query: string, wrap: number): LogIndex {
  const rows: number[] = [];
  const points: number[] = [],
    anchors: number[] = [];
  let start = 0,
    line = 1,
    columns = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    anchors.push(points.length / 2);
    let segment = start,
      width = 0,
      maximum = 0,
      checkpoint = start;
    points.push(start, 0);
    for (let cursor = start; cursor < end; ) {
      if (cursor - checkpoint >= 128) {
        points.push(cursor, maximum);
        checkpoint = cursor;
      }
      const code = text.codePointAt(cursor) ?? 0;
      const size = code > 0xffff ? 2 : 1;
      let count = cells(code, width);
      if (wrap && width + count > wrap && cursor > segment) {
        rows.push(segment, cursor, line);
        segment = cursor;
        width = 0;
        count = cells(code, 0);
      }
      width += count;
      maximum += cells(code, maximum);
      cursor += size;
    }
    points.push(end, maximum);
    rows.push(segment, end, line);
    columns = Math.max(columns, wrap ? Math.min(maximum, wrap) : maximum);
    start = end + 1;
    line++;
  }
  anchors.push(points.length / 2);
  const matches: number[] = [];
  if (query) {
    let offset = text.indexOf(query);
    while (offset >= 0) {
      matches.push(offset);
      offset = text.indexOf(query, offset + query.length);
    }
  }
  return {
    rows: Uint32Array.from(rows),
    matches: Uint32Array.from(matches),
    columns,
    points: Uint32Array.from(points),
    anchors: Uint32Array.from(anchors),
  };
}
