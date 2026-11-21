import { setImmediate } from "node:timers/promises";
import { EditNotUniqueError, ExecError } from "../core/types.ts";
import { relaxedMatch } from "./edit-match.ts";

const maxWriteBytes = 64 * 1024 * 1024;
/** Each span is an object; the output cap alone still allows millions of tiny replacements. */
const maxSpans = 1_000_000;

export interface TextEdit {
  old: string;
  new: string;
  replaceAll?: boolean;
  /** Patch hunks address complete lines and may explicitly pin the end of the file. */
  lineBased?: boolean;
  endOfFile?: boolean;
}

interface Span {
  start: number;
  end: number;
  replacement: string;
}

/**
 * One file, several replacements, all or nothing: a stale `old` in any edit fails the whole
 * call, so a partial write cannot leave the file half-edited. Every edit is located on the
 * original text — matching in sequence would let a later edit hit text an earlier one inserted,
 * and would silently accept two edits that touch the same range.
 */
export async function applyEdits(
  text: string,
  edits: readonly TextEdit[],
  signal: AbortSignal,
): Promise<Buffer> {
  const spans: Span[] = [];
  // Bounded while collecting: a replaceAll on a large file would otherwise materialise every span
  // before the size check below ever runs. Spans go straight into `spans` to avoid a second copy.
  const budget = { bytes: Buffer.byteLength(text), spans: 0 };
  for (const edit of edits) await locate(text, edit, signal, budget, spans);
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  let bytes = Buffer.byteLength(text);
  let previousEnd = 0;
  for (const span of spans) {
    if (span.start < previousEnd) throw new ExecError("edit_overlap");
    bytes +=
      Buffer.byteLength(span.replacement) - Buffer.byteLength(text.slice(span.start, span.end));
    if (bytes > maxWriteBytes) throw new ExecError("invalid_input");
    previousEnd = span.end;
  }
  // A single exact-sized buffer avoids millions of split entries or a chain of string ropes.
  const result = Buffer.allocUnsafe(bytes);
  let source = 0;
  let written = 0;
  let spliced = 0;
  for (const span of spans) {
    signal.throwIfAborted();
    written += result.write(text.slice(source, span.start), written, "utf8");
    written += result.write(span.replacement, written, "utf8");
    source = span.end;
    if (++spliced % 4096 === 0) await setImmediate(undefined, { signal });
  }
  written += result.write(text.slice(source), written, "utf8");
  if (written !== bytes) throw new ExecError("invalid_input");
  return result;
}

/** Where one edit applies in `text`; a nonunique single edit fails rather than picking one. */
async function locate(
  text: string,
  edit: TextEdit,
  signal: AbortSignal,
  budget: { bytes: number; spans: number },
  spans: Span[],
): Promise<void> {
  assertSingleScalars(edit.old, edit.new);
  // An empty needle would match everywhere and never advance the scan.
  if (!edit.old) throw new ExecError("invalid_input");
  const replaceAll = edit.replaceAll ?? false;
  const nextMatch = (from: number) => {
    let at = text.indexOf(edit.old, from);
    while (at >= 0 && edit.lineBased && at > 0 && text[at - 1] !== "\n")
      at = text.indexOf(edit.old, at + 1);
    return at;
  };
  const first = nextMatch(0);
  if (first < 0) {
    const span = await relaxedMatch(text, edit.old, edit.new, signal);
    budget.spans++;
    budget.bytes +=
      Buffer.byteLength(span.replacement) - Buffer.byteLength(text.slice(span.start, span.end));
    if (budget.spans > maxSpans || budget.bytes > maxWriteBytes)
      throw new ExecError("invalid_input");
    if (edit.endOfFile && span.end !== text.length) throw new ExecError("edit_not_unique");
    spans.push(span);
    return;
  }
  if (!replaceAll && nextMatch(first + 1) >= 0)
    throw new EditNotUniqueError(countMatches(nextMatch, edit.old));
  const delta = Buffer.byteLength(edit.new) - Buffer.byteLength(edit.old);
  let matches = 0;
  for (let position = first; position >= 0; position = nextMatch(position + edit.old.length)) {
    signal.throwIfAborted();
    budget.spans += 1;
    budget.bytes += delta;
    if (budget.spans > maxSpans || budget.bytes > maxWriteBytes)
      throw new ExecError("invalid_input");
    if (edit.endOfFile && position + edit.old.length !== text.length)
      throw new ExecError("edit_not_unique");
    spans.push({ start: position, end: position + edit.old.length, replacement: edit.new });
    if (!replaceAll) break;
    if (++matches % 4096 === 0) await setImmediate(undefined, { signal });
  }
}

/**
 * How often `old` matches. Stops past `maxCountedMatches`: a short needle can match millions of
 * times, and the failure only needs a number the model can act on, not an exact total.
 */
const maxCountedMatches = 100;
function countMatches(nextMatch: (from: number) => number, needle: string) {
  let count = 0;
  for (let at = nextMatch(0); at >= 0; at = nextMatch(at + needle.length)) {
    if (++count > maxCountedMatches) return undefined;
  }
  return count;
}

/** UTF-8 counting assumes matches never split a decoded scalar into lone surrogate halves. */
function assertSingleScalars(old: string, replacement: string) {
  if (/[\uD800-\uDFFF]/u.test(old) || /[\uD800-\uDFFF]/u.test(replacement))
    throw new ExecError("invalid_input");
}

/** Count before allocating; yield so cancellation and deadlines can interrupt dense matches. */
export async function replaceText(
  text: string,
  old: string,
  replacement: string,
  replaceAll: boolean,
  signal: AbortSignal,
) {
  return applyEdits(text, [{ old, new: replacement, replaceAll }], signal);
}
