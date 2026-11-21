import { setImmediate } from "node:timers/promises";
import { ExecError } from "../core/types.ts";

export interface EditMatch {
  start: number;
  end: number;
  replacement: string;
}

const indent = (line: string) => /^[\t ]*/u.exec(line)?.[0] ?? "";
const trailing = (line: string) => line.replace(/[\t ]+$/u, "");

/** Only a uniform indentation shift is accepted; internal whitespace remains significant. */
export async function relaxedMatch(
  text: string,
  old: string,
  replacement: string,
  signal: AbortSignal,
): Promise<EditMatch> {
  // Exact edits keep their existing 64 MiB limit. The fallback must not allocate millions of lines.
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new ExecError("edit_not_unique");
  const source = text.split("\n");
  const needle = old.replaceAll("\r\n", "\n").split("\n");
  const newline = needle.at(-1) === "";
  if (newline) needle.pop();
  if (source.length > 100_000 || !needle.length) throw new ExecError("edit_not_unique");
  const nonblank = needle.filter((line) => line.trim());
  if (!nonblank.length) throw new ExecError("edit_not_unique");
  let prefix = indent(nonblank[0] as string);
  for (const line of nonblank) {
    const next = indent(line);
    while (!next.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  const normalized = needle.map((line) => (line.trim() ? trailing(line.slice(prefix.length)) : ""));
  const anchor = normalized.findIndex((line) => line.length > 0);
  const anchorLine = normalized[anchor] as string;
  const relativeIndent = indent(anchorLine);
  const body = anchorLine.slice(relativeIndent.length);
  let offset = 0;
  let found: EditMatch | undefined;
  let comparisons = 0;
  for (let at = 0; at + needle.length <= source.length; at++) {
    if (at % 256 === 0) await setImmediate(undefined, { signal });
    const first = (source[at + anchor] ?? "").replace(/\r$/u, "");
    const leading = indent(first);
    if (trailing(first.slice(leading.length)) === body && leading.endsWith(relativeIndent)) {
      const shifted = leading.slice(0, leading.length - relativeIndent.length);
      let matches = true;
      for (let i = 0; i < needle.length; i++) {
        if (++comparisons > 2_000_000) throw new ExecError("edit_not_unique");
        const line = (source[at + i] ?? "").replace(/\r$/u, "");
        const expected = normalized[i] as string;
        if (
          expected
            ? !line.startsWith(shifted) || trailing(line.slice(shifted.length)) !== expected
            : !!line.trim()
        ) {
          matches = false;
          break;
        }
      }
      if (matches) {
        if (found) throw new ExecError("edit_not_unique");
        const lines = replacement.replaceAll("\r\n", "\n").split("\n");
        let adjusted = lines
          .map((line) => {
            if (!line.trim()) return line;
            if (!line.startsWith(prefix)) throw new ExecError("edit_not_unique");
            return shifted + line.slice(prefix.length);
          })
          .join(text.includes("\r\n") ? "\r\n" : "\n");
        let end = offset;
        for (let i = 0; i < needle.length; i++) end += (source[at + i]?.length ?? 0) + 1;
        if (newline && end > text.length) adjusted = adjusted.replace(/\r?\n$/u, "");
        end = Math.min(end, text.length + (newline ? 0 : 1));
        if (!newline) end -= source[at + needle.length - 1]?.endsWith("\r") ? 2 : 1;
        found = { start: offset, end: Math.min(end, text.length), replacement: adjusted };
      }
    }
    offset += (source[at]?.length ?? 0) + 1;
  }
  signal.throwIfAborted();
  if (!found) throw new ExecError("edit_not_unique");
  return found;
}
