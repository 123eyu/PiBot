import type { OfficeChangeItem } from "@pibot/office-contract";
import type { OfficePackage } from "../ooxml/package.ts";

/** One line per object: the panel lists changes, so a long paragraph must not push the rest off. */
const LABEL = 160;
/**
 * Attributes Word and PowerPoint rewrite on every save (revision ids, paragraph ids). Comparing
 * them would report the whole document as changed after a single keystroke elsewhere.
 */
const VOLATILE =
  / (?:w:rsid\w*|w1[45]:paraId|w1[45]:textId|w:paraId|w:textId|p14:creationId|a14:creationId)="[^"]*"/gu;

/** The newest content a single object of one side occupies, in the part it lives in. */
export interface Side {
  /** Position on this side, prefixed by kind; stable for one pair of versions. */
  id: string;
  kind: OfficeChangeItem["kind"];
  page: number | null;
  name: string | null;
  area: string | null;
  /** What the user reads in the list; plain document text, never UI copy. */
  text: string;
  /** Equal signatures on both sides mean the object did not change. */
  signature: string;
  /** The object's own markup, used as the source when restoring from this side. */
  raw: string;
  part: string;
  span: { start: number; end: number };
}

/** One change plus, when possible, how to take that object back to the older side. */
export interface Change {
  item: OfficeChangeItem;
  apply?(after: OfficePackage): void;
}

export function clip(value: string): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > LABEL ? `${text.slice(0, LABEL - 1)}…` : text;
}

export function normalize(raw: string): string {
  return raw.replace(VOLATILE, "");
}

/** An item id is built from the newer side so both the list and the restore resolve it. */
export function item(
  id: string,
  before: Side | undefined,
  after: Side | undefined,
  apply: ((after: OfficePackage) => void) | undefined,
): Change {
  const side = after ?? before;
  if (!side) throw new Error("office_invalid");
  return {
    item: {
      id,
      kind: side.kind,
      page: side.page,
      name: side.name,
      area: side.area,
      before: before ? clip(before.text) || null : null,
      after: after ? clip(after.text) || null : null,
      retractable: apply !== undefined,
    },
    apply,
  };
}

/** Replaces the object on the newer side with the older side's markup. */
export function replaceWith(side: Side, raw: string) {
  return (pkg: OfficePackage) => {
    const current = pkg.xml(side.part);
    pkg.replaceXml(
      side.part,
      current.source.slice(0, side.span.start) + raw + current.source.slice(side.span.end),
    );
  };
}

/** Removes an object the newer side added. */
export function removeAt(side: Side) {
  return (pkg: OfficePackage) => {
    const current = pkg.xml(side.part);
    pkg.replaceXml(
      side.part,
      current.source.slice(0, side.span.start) + current.source.slice(side.span.end),
    );
  };
}

/** Re-inserts an object the older side had, at the position the alignment left it. */
export function insertAt(part: string, offset: number, raw: string) {
  return (pkg: OfficePackage) => {
    const current = pkg.xml(part);
    pkg.replaceXml(part, current.source.slice(0, offset) + raw + current.source.slice(offset));
  };
}

interface Comparable {
  id: string;
  signature: string;
}
export interface Paired<T> {
  op: "equal" | "modify" | "add" | "remove";
  before?: T;
  after?: T;
}

/**
 * Myers would be cheaper, but documents here are bounded (the object count is capped before this)
 * and a sequence matcher keeps an inserted paragraph from reporting every later one as changed.
 */
function alignment(before: string[], after: string[]) {
  const n = before.length;
  const m = after.length;
  const ops: { op: "equal" | "delete" | "insert"; old?: number; next?: number }[] = [];
  // A quadratic table would be the whole cost of comparing two large documents; past the cap a
  // positional walk reports more changes than needed but stays fast and bounded.
  if (n * m > 250_000) {
    for (let index = 0; index < Math.max(n, m); index++) {
      if (index < n && index < m) ops.push({ op: "equal", old: index, next: index });
      else if (index < n) ops.push({ op: "delete", old: index });
      else ops.push({ op: "insert", next: index });
    }
    return ops;
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ op: "equal", old: i++, next: j++ });
      continue;
    }
    if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number))
      ops.push({ op: "delete", old: i++ });
    else ops.push({ op: "insert", next: j++ });
  }
  while (i < n) ops.push({ op: "delete", old: i++ });
  while (j < m) ops.push({ op: "insert", next: j++ });
  return ops;
}

/**
 * Aligns two sides and turns each run of removed and added objects into one modification per
 * position, so "the third paragraph was rewritten" reads as one change rather than two.
 */
export function pair<T extends Comparable>(before: T[], after: T[]): Paired<T>[] {
  const ops = alignment(
    before.map((block) => block.signature),
    after.map((block) => block.signature),
  );
  const result: Paired<T>[] = [];
  let removed: T[] = [];
  let added: T[] = [];
  const flush = () => {
    const shared = Math.min(removed.length, added.length);
    for (let index = 0; index < shared; index++)
      result.push({ op: "modify", before: removed[index], after: added[index] });
    for (const block of removed.slice(shared)) result.push({ op: "remove", before: block });
    for (const block of added.slice(shared)) result.push({ op: "add", after: block });
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.op === "delete") {
      removed.push(before[op.old as number] as T);
      continue;
    }
    if (op.op === "insert") {
      added.push(after[op.next as number] as T);
      continue;
    }
    flush();
    result.push({ op: "equal", before: before[op.old as number], after: after[op.next as number] });
  }
  flush();
  return result;
}
