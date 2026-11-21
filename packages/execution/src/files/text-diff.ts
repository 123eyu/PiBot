import { setImmediate } from "node:timers/promises";

export const DIFF_LIMIT = 4000;
const omitted = "\n[diff truncated / 差异已截断]";

export function boundDiff(text: string) {
  if (text.length <= DIFF_LIMIT) return text;
  return text.slice(0, DIFF_LIMIT - omitted.length).replace(/[\uD800-\uDBFF]$/u, "") + omitted;
}

/** One replacement hunk is a real diff even for distant edits, without a quadratic LCS matrix. */
export async function textDiff(
  path: string,
  before: string | null,
  after: string | null,
  signal: AbortSignal,
): Promise<string> {
  const old = before ?? "";
  const next = after ?? "";
  if (old === next && before !== null && after !== null) return "";
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) {
    if (start % 65536 === 0) await setImmediate(undefined, { signal });
    start++;
  }
  while (start > 0 && old[start - 1] !== "\n") start--;
  let oldEnd = old.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && old[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
    if (oldEnd % 65536 === 0) await setImmediate(undefined, { signal });
  }
  while (oldEnd < old.length && old[oldEnd - 1] !== "\n") {
    oldEnd++;
    newEnd++;
  }
  const count = async (text: string, from: number, to: number) => {
    let lines = 0;
    for (let i = from; i < to; i++) {
      if (i % 65536 === 0) await setImmediate(undefined, { signal });
      if (text[i] === "\n") lines++;
    }
    return lines + (to > from && text[to - 1] !== "\n" ? 1 : 0);
  };
  const line = await count(old, 0, start);
  const removed = await count(old, start, oldEnd);
  const added = await count(next, start, newEnd);
  const safePath = path.replace(/[\r\n\t]/gu, " ");
  let diff = `--- ${before === null ? "/dev/null" : `a/${safePath}`}\n+++ ${after === null ? "/dev/null" : `b/${safePath}`}\n@@ -${removed ? line + 1 : line},${removed} +${added ? line + 1 : line},${added} @@\n`;
  for (const [text, end, sign] of [
    [old, oldEnd, "-"],
    [next, newEnd, "+"],
  ] as const) {
    let cursor = start;
    while (cursor < end) {
      signal.throwIfAborted();
      const newline = text.indexOf("\n", cursor);
      const stop = newline < 0 || newline >= end ? end : newline + 1;
      const room = DIFF_LIMIT + 1 - diff.length;
      diff += sign + text.slice(cursor, Math.min(stop, cursor + Math.max(0, room)));
      if (diff.length > DIFF_LIMIT || stop - cursor > room) return boundDiff(diff + omitted);
      if (text[stop - 1] !== "\n") diff += "\n\\ No newline at end of file\n";
      cursor = stop;
    }
  }
  return boundDiff(diff);
}
