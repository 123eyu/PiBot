import { useT } from "@pibot/renderer-kit";
import type { DiffHunk, ReviewFinding } from "@pibot/workspaces-contract/full";
import { type CSSProperties, Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import styles from "../changes.module.css";
import { ChangesIcon } from "../icons.tsx";
import { type DiffLine, gapRange, hunkContext, type ListFile, parseHunk } from "../model.ts";
import { CommentCard, CommentEditor } from "../review/CommentParts.tsx";
import type { CommentAnchor, DraftComment } from "../review/comments.ts";
import { FindingCard } from "../review/ReviewParts.tsx";
import { EXPAND_STEP, type Expansion, type GapState } from "../use-expansion.ts";
import type { DiffActions } from "./DiffView.tsx";
import { formatCount } from "./FileList.tsx";

/** Lines per rendered block; blocks below the fold are added as the reader scrolls. */
const CHUNK = 200;
// Off-screen blocks are sized from their row count: a fixed estimate (was 4000px) made a 60-line
// diff report ~12,000px of scroll height until each block had been painted once.
const chunkStyle = (rows: number) => ({ "--rows": rows }) as CSSProperties;
const HUNKS_FIRST = 40;

/** Everything a line can carry besides its text: comments, the comment editor and findings. */
export interface LineNotes {
  commentable: boolean;
  comments: readonly DraftComment[];
  editing?: CommentAnchor;
  findings: readonly ReviewFinding[];
  botName: string;
  /** Who wrote the findings, when another Bot reviewed. */
  reviewerName?: string;
  busy: boolean;
  actions: DiffActions;
}

/**
 * Renders `first` items, then grows by `step` whenever the sentinel nears the viewport, so
 * "show all" on a 10,000-line file does not build every row up front (no jank).
 */
function useProgressive(total: number, first: number, step: number) {
  const [count, setCount] = useState(first);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || count >= total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setCount((value) => Math.min(total, value + step));
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [count, total, step]);
  return [Math.min(count, total), sentinel] as const;
}

const inNew = (hunk: DiffHunk, line: number) =>
  line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1);
const inOld = (hunk: DiffHunk, line: number) =>
  line >= hunk.oldStart && line < hunk.oldStart + Math.max(hunk.oldLines, 1);

export function Hunks({
  file,
  hunks,
  hunkDiscard,
  notes,
  expansion,
}: {
  file: ListFile;
  hunks: readonly DiffHunk[];
  hunkDiscard?: (hunk: DiffHunk) => void;
  notes: LineNotes;
  expansion?: Expansion;
}) {
  const t = useT();
  const parsed = useMemo(() => hunks.map(parseHunk), [hunks]);
  const [shown, sentinel] = useProgressive(hunks.length, HUNKS_FIRST, HUNKS_FIRST);
  const gaps = expansion?.gaps;
  // Findings on lines that are not part of any hunk or revealed context stay at the top.
  const elsewhere = useMemo(() => {
    const revealed = new Set<number>();
    for (const gap of gaps?.values() ?? [])
      for (const line of [...gap.top, ...gap.bottom]) if (line.new !== null) revealed.add(line.new);
    return notes.findings.filter(
      (item) =>
        item.line === null ||
        (!revealed.has(item.line) && !hunks.some((hunk) => inNew(hunk, item.line as number))),
    );
  }, [notes.findings, gaps, hunks]);
  const gapAt = (index: number) => {
    const range = expansion ? gapRange(hunks, index, expansion.total) : undefined;
    if (!range && index < hunks.length) {
      // No expansion available (e.g. older brain): keep the plain "N unchanged lines" note.
      const previous = hunks[index - 1];
      const hunk = hunks[index] as DiffHunk;
      const count = previous
        ? hunk.oldStart - (previous.oldStart + previous.oldLines)
        : hunk.oldStart - 1;
      return count > 0 ? (
        <p className={styles.gap}>{t("changes.diff.unchanged", { count: formatCount(count) })}</p>
      ) : null;
    }
    if (!range || range.to < range.from || !expansion) return null;
    return (
      <Gap
        index={index}
        size={range.to - range.from + 1}
        trailing={index === hunks.length}
        state={expansion.gaps.get(index)}
        expand={expansion.expand}
        notes={notes}
      />
    );
  };
  return (
    <>
      {elsewhere.length > 0 && (
        <div className={styles.findingsTop}>
          {elsewhere.some((item) => item.line !== null) && (
            <p className={styles.footNote}>{t("changes.review.elsewhere")}</p>
          )}
          {elsewhere.map((item) => (
            <FindingCard
              key={item.id}
              finding={item}
              botName={notes.reviewerName ?? notes.botName}
              actions={notes.actions.finding}
              busy={notes.busy}
              showRef
            />
          ))}
        </div>
      )}
      {hunks.slice(0, shown).map((hunk, index) => {
        const lines = parsed[index] as DiffLine[];
        const newTest = (line: number) => inNew(hunk, line);
        const hunkComments = notes.comments.filter(
          (comment) =>
            comment.side !== "file" &&
            (comment.side === "new" ? newTest(comment.to) : inOld(hunk, comment.to)),
        );
        const editing =
          notes.editing &&
          notes.editing.side !== "file" &&
          (notes.editing.side === "new" ? newTest(notes.editing.to) : inOld(hunk, notes.editing.to))
            ? notes.editing
            : undefined;
        const findings = notes.findings.filter((item) => item.line !== null && newTest(item.line));
        return (
          <Fragment key={hunk.digest}>
            {gapAt(index)}
            <Hunk
              hunk={hunk}
              lines={lines}
              onDiscard={hunkDiscard}
              notes={{ ...notes, comments: hunkComments, editing, findings }}
              fileKey={file.key}
            />
          </Fragment>
        );
      })}
      {shown < hunks.length && <div ref={sentinel} className={styles.sentinel} />}
      {shown >= hunks.length && gapAt(hunks.length)}
    </>
  );
}

/** "Show N unchanged lines" between hunks, with the lines already revealed above and below it. */
function Gap({
  index,
  size,
  trailing,
  state,
  expand,
  notes,
}: {
  index: number;
  size: number;
  trailing: boolean;
  state?: GapState;
  expand: Expansion["expand"];
  notes: LineNotes;
}) {
  const t = useT();
  const top = state?.top ?? [];
  const bottom = state?.bottom ?? [];
  const remaining = size - top.length - bottom.length;
  const block = (lines: DiffLine[]) =>
    lines.length > 0 && <Revealed lines={lines} notes={linesNotes(notes, lines)} />;
  return (
    <>
      {block(top)}
      {remaining > 0 && (
        <div className={styles.gapRow}>
          {state?.loading ? (
            <span className={styles.gapButton} role="status">
              <span className={styles.spin} aria-hidden="true" />
              {t("common.loading")}
            </span>
          ) : (
            <button
              type="button"
              className={styles.gapButton}
              onClick={() => expand(index, "near")}
            >
              <ChangesIcon name={trailing ? "down" : "up"} size={13} />
              {state?.error
                ? t("changes.diff.expandFailed")
                : remaining <= EXPAND_STEP
                  ? t("changes.diff.expand", { count: formatCount(remaining) })
                  : t(trailing ? "changes.diff.expandDown" : "changes.diff.expandUp")}
            </button>
          )}
          {remaining > EXPAND_STEP && !state?.loading && (
            <>
              <span className={styles.gapRest}>
                {t("changes.diff.expandRest", { count: formatCount(remaining) })}
              </span>
              <button
                type="button"
                className={styles.gapButton}
                onClick={() => expand(index, "all")}
              >
                {t("changes.diff.expandAll")}
              </button>
            </>
          )}
        </div>
      )}
      {block(bottom)}
    </>
  );
}

/**
 * Revealed context, rendered like a hunk body: 200-line blocks added as the reader scrolls, each
 * with content-visibility, so "Show all" on a 2,000-line gap stays responsive (measured: one
 * block of 2,000 rows took ~400 ms to appear).
 */
function Revealed({ lines, notes }: { lines: DiffLine[]; notes: LineNotes }) {
  const [shown, sentinel] = useProgressive(lines.length, CHUNK, CHUNK * 2);
  const chunks: number[] = [];
  for (let start = 0; start < shown; start += CHUNK) chunks.push(start);
  return (
    <div className={styles.expanded}>
      <div className={styles.code}>
        {chunks.map((start) => (
          <div
            key={start}
            className={styles.chunk}
            style={chunkStyle(Math.min(CHUNK, shown - start))}
          >
            {lines.slice(start, Math.min(start + CHUNK, shown)).map((line) => (
              <LineRow key={line.new} line={line} notes={notes} />
            ))}
          </div>
        ))}
        {shown < lines.length && <div ref={sentinel} className={styles.sentinel} />}
      </div>
    </div>
  );
}

/** Narrows comments / findings / the editor to the revealed lines (all on the newer side). */
function linesNotes(notes: LineNotes, lines: DiffLine[]): LineNotes {
  const first = lines[0]?.new ?? 0;
  const last = lines.at(-1)?.new ?? -1;
  const inside = (line: number) => line >= first && line <= last;
  return {
    ...notes,
    comments: notes.comments.filter((item) => item.side === "new" && inside(item.to)),
    editing: notes.editing?.side === "new" && inside(notes.editing.to) ? notes.editing : undefined,
    findings: notes.findings.filter((item) => item.line !== null && inside(item.line)),
  };
}

const Hunk = memo(function Hunk({
  hunk,
  lines,
  onDiscard,
  notes,
}: {
  hunk: DiffHunk;
  lines: readonly DiffLine[];
  onDiscard?: (hunk: DiffHunk) => void;
  notes: LineNotes;
  fileKey: string;
}) {
  const t = useT();
  const context = hunkContext(hunk.header);
  const [shown, sentinel] = useProgressive(lines.length, CHUNK * 2, CHUNK * 2);
  const chunks: number[] = [];
  for (let start = 0; start < shown; start += CHUNK) chunks.push(start);
  return (
    <div className={styles.hunk}>
      <div className={styles.hunkHead}>
        <span>
          {t("changes.diff.hunkStart", { line: hunk.newStart || hunk.oldStart })}
          {context && ` · ${context}`}
        </span>
        {onDiscard && (
          <button type="button" className={styles.mini} onClick={() => onDiscard(hunk)}>
            <ChangesIcon name="undo" size={12} />
            {t("changes.discard.hunk")}
          </button>
        )}
      </div>
      <div className={styles.code}>
        {chunks.map((start) => (
          // Off-screen blocks skip layout and paint (content-visibility), keeping scroll smooth.
          <div
            key={start}
            className={styles.chunk}
            style={chunkStyle(Math.min(CHUNK, shown - start))}
          >
            {lines.slice(start, Math.min(start + CHUNK, shown)).map((line, offset) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a hunk's lines never reorder
              <LineRow key={start + offset} line={line} notes={notes} />
            ))}
          </div>
        ))}
        {shown < lines.length && <div ref={sentinel} className={styles.sentinel} />}
      </div>
    </div>
  );
});

function LineRow({ line, notes }: { line: DiffLine; notes: LineNotes }) {
  const t = useT();
  const { actions, editing, commentable } = notes;
  const side = line.kind === "del" ? ("old" as const) : ("new" as const);
  const number = side === "old" ? line.old : line.new;
  const selected =
    !!editing &&
    number !== null &&
    editing.side === side &&
    number >= editing.from &&
    number <= editing.to;
  const below = notes.comments.filter((comment) => comment.side === side && comment.to === number);
  const findings =
    side === "new" && number !== null ? notes.findings.filter((item) => item.line === number) : [];
  const lineTitle = commentable ? t("changes.comment.lineTitle") : undefined;
  const click =
    commentable && number !== null && line.kind !== "meta"
      ? (event: { shiftKey: boolean }) => actions.line(side, number, event.shiftKey)
      : undefined;
  return (
    <>
      <div className={styles.line} data-kind={line.kind} data-selected={selected || undefined}>
        <span className={styles.num} onClick={click} title={lineTitle} aria-hidden="true">
          {line.old ?? ""}
        </span>
        <span className={styles.num} onClick={click} title={lineTitle} aria-hidden="true">
          {line.new ?? ""}
        </span>
        <span className={styles.sign} aria-hidden="true">
          {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
        </span>
        <span className={styles.text}>
          {line.mark ? (
            <>
              {line.text.slice(0, line.mark[0])}
              <mark>{line.text.slice(line.mark[0], line.mark[1])}</mark>
              {line.text.slice(line.mark[1])}
            </>
          ) : (
            line.text || " "
          )}
        </span>
        {click && (
          <button
            type="button"
            className={styles.addComment}
            aria-label={t("changes.comment.lineAction", { line: number ?? 0 })}
            title={lineTitle}
            onClick={click}
          >
            <ChangesIcon name="plus" size={12} />
          </button>
        )}
      </div>
      {findings.map((item) => (
        <FindingCard
          key={item.id}
          finding={item}
          botName={notes.reviewerName ?? notes.botName}
          actions={actions.finding}
          busy={notes.busy}
          inline
        />
      ))}
      {below.map((comment) => (
        <CommentCard key={comment.id} comment={comment} onDelete={actions.deleteComment} inline />
      ))}
      {editing && editing.side === side && editing.to === number && (
        <CommentEditor
          anchor={editing}
          botName={notes.botName}
          onSave={actions.saveComment}
          onCancel={actions.cancelComment}
          inline
        />
      )}
    </>
  );
}
