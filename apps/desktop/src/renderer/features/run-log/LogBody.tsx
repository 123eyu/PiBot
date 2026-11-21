import { type ReactNode, useEffect, useRef, useState } from "react";
import { type LogSnapshot, lowerBound } from "./index-log.ts";
import {
  displayText,
  locate,
  MAX_RENDER_CHARACTERS,
  MAX_ROW_CHARACTERS,
  MAX_VISIBLE_ROWS,
  rowSlice,
} from "./render-log.ts";
import styles from "./viewer.module.css";

const HEIGHT = 20;
// Browser layout dimensions have a finite ceiling; scale scroll coordinates,
// while each visible row keeps its actual line height and text width.
const MAX_SCROLL = 8_000_000;
function axis(extent: number, viewport: number) {
  const distance = Math.max(0, extent - viewport);
  const scroll = Math.min(distance, MAX_SCROLL);
  return { size: Math.min(extent, viewport + scroll), scale: scroll ? distance / scroll : 1 };
}
function highlighted(
  text: string,
  start: number,
  end: number,
  query: string,
  matches: Uint32Array,
  active: number,
  column: number,
) {
  end = Math.min(end, start + MAX_ROW_CHARACTERS);
  if (!query) return displayText(text.slice(start, end), column).text;
  const parts: ReactNode[] = [];
  let cursor = start;
  const display = (from: number, to: number) => {
    const result = displayText(text.slice(from, to), column);
    column = result.column;
    return result.text;
  };
  for (
    let i = Math.max(0, lowerBound(matches, start) - 1);
    i < matches.length && (matches[i] ?? 0) < end;
    i++
  ) {
    const match = matches[i] ?? 0;
    if (match + query.length <= start) continue;
    const from = Math.max(start, match),
      to = Math.min(end, match + query.length);
    parts.push(display(cursor, from));
    parts.push(
      <mark key={match} className={i === active ? styles.activeMatch : styles.match}>
        {display(from, to)}
      </mark>,
    );
    cursor = to;
  }
  parts.push(display(cursor, end));
  return parts;
}
export function LogBody({
  snapshot,
  active,
  jump,
  onWidth,
  more,
  label,
}: {
  snapshot: LogSnapshot;
  active: number;
  jump: number;
  onWidth(columns: number): void;
  more(): void;
  label: string;
}) {
  const { text, query, wrap, index } = snapshot;
  const viewport = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, height: 400, width: 800 });
  const [cell, setCell] = useState(8);
  const rowCount = index.rows.length / 3;
  const vertical = axis(rowCount * HEIGHT, position.height);
  const horizontal = axis(
    wrap ? position.width : Math.max(position.width, index.columns * cell + 96),
    position.width,
  );
  const realTop = position.top * vertical.scale;
  const realLeft = position.left * horizontal.scale;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observe = new ResizeObserver(() => {
      setPosition((value) => ({
        ...value,
        height: element.clientHeight,
        width: element.clientWidth,
      }));
      const canvas = document.createElement("canvas").getContext("2d");
      if (canvas) canvas.font = getComputedStyle(element).font;
      const width = canvas?.measureText("0").width || 8;
      setCell(width);
      onWidth(Math.max(10, Math.floor((element.clientWidth - 80) / width)));
    });
    observe.observe(element);
    return () => observe.disconnect();
  }, [onWidth]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Preserve search navigation across new layout snapshots, not every scroll.
  useEffect(() => {
    if (!jump) return;
    const target = index.matches[active];
    if (target === undefined || !viewport.current) return;
    let low = 0,
      high = rowCount;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((index.rows[mid * 3 + 1] ?? 0) <= target) low = mid + 1;
      else high = mid;
    }
    viewport.current.scrollTop = (low * HEIGHT) / vertical.scale;
    const line = index.rows[low * 3 + 2] ?? 0;
    viewport.current.scrollLeft = wrap
      ? 0
      : Math.max(0, locate(index, text, line, target, false).column * cell - 40) / horizontal.scale;
  }, [jump, snapshot]);
  const first = Math.max(0, Math.floor(realTop / HEIGHT) - 8);
  const last = Math.min(
    rowCount,
    first + Math.min(MAX_VISIBLE_ROWS, Math.ceil(position.height / HEIGHT) + 16),
  );
  const rows = [];
  let remaining = MAX_RENDER_CHARACTERS;
  for (let row = first; row < last && remaining > 0; row++) {
    const { from, to, column, line } = rowSlice(
      snapshot,
      row,
      Math.max(0, Math.floor(realLeft / cell) - 8),
      Math.min(remaining, Math.ceil(position.width / cell) + 32),
    );
    remaining -= to - from;
    rows.push(
      <div key={row} className={styles.line} style={{ top: position.top + row * HEIGHT - realTop }}>
        <span className={styles.number} style={{ left: position.left }}>
          {line}
        </span>
        <span
          className={styles.code}
          style={{ left: position.left + 72 + column * cell - realLeft }}
        >
          {highlighted(text, from, to, query, index.matches, active, column)}
        </span>
      </div>,
    );
  }
  return (
    <section
      ref={viewport}
      className={styles.body}
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The virtual log needs keyboard scrolling without rendering every line.
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        setPosition({
          top: element.scrollTop,
          left: element.scrollLeft,
          height: element.clientHeight,
          width: element.clientWidth,
        });
        if (element.scrollHeight - element.clientHeight - element.scrollTop < 120) more();
      }}
    >
      <div
        className={styles.canvas}
        style={{
          height: vertical.size,
          width: horizontal.size,
        }}
      >
        {rows}
      </div>
    </section>
  );
}
