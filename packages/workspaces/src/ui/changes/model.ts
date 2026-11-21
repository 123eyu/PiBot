import type { TranslationKey } from "@pibot/i18n";
import type { ChangeFile, ChangesTurn, DiffHunk } from "@pibot/workspaces-contract/full";

type TurnFile = ChangesTurn["files"][number];

export type ChangesScopeName = "uncommitted" | "turn" | "history";
export type FileTag = "M" | "A" | "D" | "U" | "T" | "C" | "X";

/** One row in any of the three scopes; `key` is what changes.diff expects for that scope. */
export interface ListFile {
  key: string;
  display: string;
  tag: FileTag;
  added: number | null;
  removed: number | null;
  binary: boolean;
  generated: boolean;
  /** "This turn" files written by a command have only a name, no diff. */
  command: boolean;
  diffAvailable: boolean;
  /** "This turn" only: the brain says it can open in the file preview pane. */
  previewable?: boolean;
}

const STATUS_TAGS: Record<ChangeFile["status"], FileTag> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
  typechange: "T",
  conflicted: "C",
};
const TURN_TAGS: Record<TurnFile["kind"], FileTag> = {
  add: "A",
  modify: "M",
  delete: "D",
  command: "X",
};

export function fromChangeFile(file: ChangeFile): ListFile {
  return {
    key: file.path,
    display: file.path,
    tag: STATUS_TAGS[file.status],
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    generated: file.generated,
    command: false,
    diffAvailable: true,
  };
}

/** Mirrors the brain's isGenerated for "this turn" files, which carry no generated flag. */
const GENERATED =
  /(^|\/)(node_modules|dist|build|out|vendor|\.next|coverage|generated)\/|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;
export function fromTurnFile(file: TurnFile): ListFile {
  return {
    key: file.path,
    display: file.displayPath,
    tag: TURN_TAGS[file.kind],
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    generated: GENERATED.test(file.displayPath),
    command: file.kind === "command",
    diffAvailable: file.diffAvailable,
    previewable: file.previewable ?? false,
  };
}

export const TAG_LABEL: Record<FileTag, TranslationKey> = {
  M: "changes.tag.M",
  A: "changes.tag.A",
  D: "changes.tag.D",
  U: "changes.tag.U",
  T: "changes.tag.T",
  C: "changes.tag.C",
  X: "changes.tag.X",
};
export const TAG_TITLE: Record<FileTag, TranslationKey> = {
  M: "changes.tagTitle.M",
  A: "changes.tagTitle.A",
  D: "changes.tagTitle.D",
  U: "changes.tagTitle.U",
  T: "changes.tagTitle.T",
  C: "changes.tagTitle.C",
  X: "changes.tagTitle.X",
};

export function baseName(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}
export function dirName(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
/** Renderer has no node:path; folder paths keep the separator style the brain reported. */
export function joinRoot(root: string, relative: string) {
  const windows = root.includes("\\") && !root.includes("/");
  const separator = windows ? "\\" : "/";
  const parts = windows ? relative.split("/") : [relative];
  return `${root.replace(/[\\/]+$/, "")}${separator}${parts.join(separator)}`;
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|heic|tiff?)$/i;
export const isImage = (path: string) => IMAGE.test(path);

export function sumLines(files: readonly ListFile[]) {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added ?? 0;
    removed += file.removed ?? 0;
  }
  return { added, removed };
}

/** Changes RPC errors carry the protocol code as their message; anything else is generic. */
export function changesErrorKey(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message : "";
  switch (message) {
    case "changes_ref_unavailable":
    case "changes_ref_dirty":
    case "changes_ref_exists":
    case "changes_busy":
    case "changes_stale":
    case "changes_author_missing":
    case "changes_operation_in_progress":
    case "changes_isolation_unavailable":
    case "changes_git_unavailable":
    case "changes_write_failed":
    case "changes_hunk_unsupported":
    case "changes_draft_unavailable":
    case "changes_draft_invalid":
    case "changes_repo_above_folder":
    case "changes_readonly_root":
    case "changes_not_repo":
    case "managed_background_running":
      return `changes.error.${message}`;
    default:
      return "changes.error.generic";
  }
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  old: number | null;
  new: number | null;
  text: string;
  /** Changed span inside a paired -/+ line: [start, end) in code units. */
  mark?: [number, number];
}

/** Pairs each removed run with the following added run and marks the differing middle. */
function markPairs(lines: DiffLine[]) {
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.kind !== "del") {
      index++;
      continue;
    }
    const delStart = index;
    while (lines[index]?.kind === "del") index++;
    const addStart = index;
    while (lines[index]?.kind === "add") index++;
    const pairs = Math.min(addStart - delStart, index - addStart);
    for (let offset = 0; offset < pairs; offset++) {
      const a = lines[delStart + offset] as DiffLine;
      const b = lines[addStart + offset] as DiffLine;
      let prefix = 0;
      const max = Math.min(a.text.length, b.text.length);
      while (prefix < max && a.text[prefix] === b.text[prefix]) prefix++;
      let suffix = 0;
      while (
        suffix < max - prefix &&
        a.text[a.text.length - 1 - suffix] === b.text[b.text.length - 1 - suffix]
      )
        suffix++;
      const longest = Math.max(a.text.length, b.text.length);
      // Highlighting most of a line adds noise rather than pointing at the change.
      if (prefix + suffix < longest * 0.3 || prefix + suffix === 0) continue;
      if (a.text.length - suffix > prefix) a.mark = [prefix, a.text.length - suffix];
      if (b.text.length - suffix > prefix) b.mark = [prefix, b.text.length - suffix];
    }
  }
}

export function parseHunk(hunk: DiffHunk): DiffLine[] {
  let old = hunk.oldStart;
  let next = hunk.newStart;
  const lines: DiffLine[] = hunk.lines.map((raw) => {
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === "+") return { kind: "add", old: null, new: next++, text };
    if (sign === "-") return { kind: "del", old: old++, new: null, text };
    if (sign === "\\") return { kind: "meta", old: null, new: null, text };
    return { kind: "ctx", old: old++, new: next++, text };
  });
  markPairs(lines);
  return lines;
}

/** A zero-length side's start is the line before the hunk (unified diff), so step past it. */
const first = (start: number, lines: number) => (lines === 0 ? start + 1 : start);
const after = (start: number, lines: number) => (lines === 0 ? start + 1 : start + lines);

/**
 * Unchanged newer-side lines [from, to] before hunk `index` (or after the last hunk when index
 * equals the hunk count, which needs the file's total). `offset` turns a newer line into the older
 * one: the context is identical on both sides, only shifted.
 */
export function gapRange(hunks: readonly DiffHunk[], index: number, total: number | null) {
  const hunk = hunks[index];
  if (hunk) {
    const previous = hunks[index - 1];
    const from = previous ? after(previous.newStart, previous.newLines) : 1;
    const start = first(hunk.newStart, hunk.newLines);
    return { from, to: start - 1, offset: first(hunk.oldStart, hunk.oldLines) - start };
  }
  const last = hunks.at(-1);
  if (!last || total === null) return undefined;
  const from = after(last.newStart, last.newLines);
  return { from, to: total, offset: after(last.oldStart, last.oldLines) - from };
}

/** Text after the second @@ is Git's guess at the enclosing function. */
export function hunkContext(header: string) {
  return /^@@[^@]*@@\s?(.*)$/.exec(header)?.[1]?.trim() ?? "";
}
