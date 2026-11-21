import { dirName, type ListFile, sumLines } from "../model.ts";

/** Big change sets start with folders collapsed, 50 files per folder at first. */
export const COLLAPSE_OVER = 200;
export const FOLDER_FIRST = 50;
const GENERATED_FIRST = 200;

export type FileRow =
  | {
      kind: "dir";
      id: string;
      dir: string;
      count: number;
      added: number;
      removed: number;
      open: boolean;
    }
  | { kind: "file"; id: string; file: ListFile; nested: boolean; full: boolean }
  | { kind: "more"; id: string; dir: string; remaining: number }
  | { kind: "generated"; id: string; count: number; added: number; removed: number; open: boolean }
  | { kind: "empty"; id: string };

export const ROW_HEIGHT: Record<FileRow["kind"], number> = {
  dir: 30,
  file: 30,
  more: 30,
  generated: 40,
  empty: 64,
};

export interface RowOptions {
  query: string;
  tree: boolean;
  /** Explicit open/closed choice per folder; absent folders follow the size default. */
  folders: ReadonlyMap<string, boolean>;
  showAll: ReadonlySet<string>;
  generatedOpen: boolean;
}

const GENERATED_KEY = "\0generated";
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function filterFiles(files: readonly ListFile[], query: string) {
  const needle = query.trim().toLowerCase();
  return needle ? files.filter((file) => file.display.toLowerCase().includes(needle)) : files;
}

/**
 * Flattens files into fixed-height rows for the virtual list. Grouping is by full folder path
 * (no nested tree) so the row count stays linear in files plus folders.
 */
export function buildRows(files: readonly ListFile[], options: RowOptions) {
  const visible = filterFiles(files, options.query);
  const main: ListFile[] = [];
  const generated: ListFile[] = [];
  for (const file of visible) (file.generated ? generated : main).push(file);
  const rows: FileRow[] = [];
  /** Navigation order for J / K: what the list shows, ignoring collapsed folders. */
  const order: ListFile[] = [];
  const collapse = files.length > COLLAPSE_OVER;
  if (options.tree) {
    const groups = new Map<string, ListFile[]>();
    for (const file of main) {
      const dir = dirName(file.display);
      const group = groups.get(dir);
      if (group) group.push(file);
      else groups.set(dir, [file]);
    }
    for (const dir of [...groups.keys()].sort(compare)) {
      const group = (groups.get(dir) as ListFile[]).sort((a, b) => compare(a.display, b.display));
      order.push(...group);
      if (!dir) {
        for (const file of group)
          rows.push({ kind: "file", id: `f:${file.key}`, file, nested: false, full: false });
        continue;
      }
      // A filter always opens folders so matches are never hidden behind a header.
      const open = options.query.trim() ? true : (options.folders.get(dir) ?? !collapse);
      const lines = sumLines(group);
      rows.push({ kind: "dir", id: `d:${dir}`, dir, count: group.length, ...lines, open });
      if (!open) continue;
      const limit = options.showAll.has(dir) ? group.length : FOLDER_FIRST;
      for (const file of group.slice(0, limit))
        rows.push({ kind: "file", id: `f:${file.key}`, file, nested: true, full: false });
      if (group.length > limit)
        rows.push({ kind: "more", id: `m:${dir}`, dir, remaining: group.length - limit });
    }
  } else {
    const sorted = [...main].sort((a, b) => compare(a.display, b.display));
    order.push(...sorted);
    for (const file of sorted)
      rows.push({ kind: "file", id: `f:${file.key}`, file, nested: false, full: true });
  }
  if (generated.length) {
    generated.sort((a, b) => compare(a.display, b.display));
    const lines = sumLines(generated);
    rows.push({
      kind: "generated",
      id: "g",
      count: generated.length,
      ...lines,
      open: options.generatedOpen,
    });
    if (options.generatedOpen) {
      order.push(...generated);
      const limit = options.showAll.has(GENERATED_KEY) ? generated.length : GENERATED_FIRST;
      for (const file of generated.slice(0, limit))
        rows.push({ kind: "file", id: `f:${file.key}`, file, nested: true, full: true });
      if (generated.length > limit)
        rows.push({
          kind: "more",
          id: "m:generated",
          dir: GENERATED_KEY,
          remaining: generated.length - limit,
        });
    }
  }
  if (!visible.length) rows.push({ kind: "empty", id: "empty" });
  return { rows, order, matched: visible.length };
}

/** Prefix offsets so the virtual list can binary-search its first visible row. */
export function rowOffsets(rows: readonly FileRow[]) {
  const offsets = new Float64Array(rows.length + 1);
  for (let index = 0; index < rows.length; index++)
    offsets[index + 1] = (offsets[index] as number) + ROW_HEIGHT[(rows[index] as FileRow).kind];
  return offsets;
}
export function firstRowAt(offsets: Float64Array, top: number) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle + 1] as number) <= top) low = middle + 1;
    else high = middle;
  }
  return low;
}
