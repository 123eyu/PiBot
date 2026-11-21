import { PopupMenu, RevealFileButton, type RevealFileSource, useT } from "@pibot/renderer-kit";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "../changes.module.css";
import { useCheckpointSelection } from "../history/FileCheckpoints.tsx";
import { ChangesIcon } from "../icons.tsx";
import { baseName, isImage, type ListFile, TAG_LABEL, TAG_TITLE } from "../model.ts";
import { type FileRow, firstRowAt, ROW_HEIGHT } from "./file-rows.ts";

const OVERSCAN = 360;
const number = new Intl.NumberFormat("en-US");
export const formatCount = (value: number) => number.format(value);

export function Tag({ file }: { file: Pick<ListFile, "tag"> }) {
  const t = useT();
  return (
    <span className={styles.tag} data-tag={file.tag} title={t(TAG_TITLE[file.tag])}>
      {t(TAG_LABEL[file.tag])}
    </span>
  );
}

function Bars({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  if (!total) return null;
  let green = Math.round((5 * added) / total);
  if (added && !green) green = 1;
  if (removed && green === 5) green = 4;
  return (
    <span className={styles.bars} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <i key={index} data-kind={index < green ? "add" : "del"} />
      ))}
    </span>
  );
}

export function FileStat({ file }: { file: ListFile }) {
  const t = useT();
  if (file.command) return <span className={styles.statMuted}>{t("changes.file.command")}</span>;
  if (file.binary)
    return (
      <span className={styles.statMuted}>
        {t(isImage(file.display) ? "changes.file.image" : "changes.file.binary")}
      </span>
    );
  // An unknown count (no git on this computer, or past the counted rows) shows nothing: a "…"
  // read as still loading and never resolved.
  if (file.added === null && file.removed === null) return null;
  return (
    <span className={styles.stat}>
      {!!file.added && <span className={styles.plus}>+{formatCount(file.added)}</span>}
      {!!file.removed && <span className={styles.minus}>−{formatCount(file.removed)}</span>}
      <Bars added={file.added ?? 0} removed={file.removed ?? 0} />
    </span>
  );
}

function FindingBadge({ count }: { count: number }) {
  const t = useT();
  return (
    <span className={styles.findingBadge} title={t("changes.review.badge")}>
      {count}
    </span>
  );
}

export interface FileListActions {
  revealSource?(file: ListFile): RevealFileSource;
  open(file: ListFile): void;
  toggleFolder(dir: string, open: boolean): void;
  showAll(dir: string): void;
  toggleGenerated(): void;
  toggleIncluded(key: string, included: boolean): void;
  discard(file: ListFile): void;
}

/** Fixed-height rows in one absolutely positioned layer; only the visible window is in the DOM. */
export const FileList = memo(function FileList({
  rows,
  offsets,
  selected,
  editable,
  excluded,
  comments,
  findings,
  query,
  actions,
}: {
  rows: readonly FileRow[];
  offsets: Float64Array;
  selected?: string;
  editable: boolean;
  excluded: ReadonlySet<string>;
  comments: ReadonlyMap<string, number>;
  /** Open review findings by row id ("f:<key>" per file, "d:<folder>" = flagged files in it). */
  findings: ReadonlyMap<string, number>;
  query: string;
  actions: FileListActions;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const frame = useRef(0);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setView({ top: node.scrollTop, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);
  // Keep the selected file visible when J / K moves past the window.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !selected) return;
    const index = rows.findIndex((row) => row.kind === "file" && row.file.key === selected);
    if (index < 0) return;
    const top = offsets[index] as number;
    const bottom = offsets[index + 1] as number;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (bottom > node.scrollTop + node.clientHeight)
      node.scrollTop = bottom - node.clientHeight;
  }, [selected, rows, offsets]);
  const total = offsets[rows.length] as number;
  const first = firstRowAt(offsets, Math.max(0, view.top - OVERSCAN));
  const last = Math.min(rows.length, firstRowAt(offsets, view.top + view.height + OVERSCAN) + 1);
  const visible = rows.slice(first, last);
  return (
    <div
      ref={scroller}
      className={styles.list}
      onScroll={(event) => {
        const node = event.currentTarget;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() =>
          setView({ top: node.scrollTop, height: node.clientHeight }),
        );
      }}
    >
      <ul
        className={styles.listInner}
        style={{ height: total }}
        aria-label={t("changes.list.label")}
      >
        {visible.map((row, index) => (
          <li
            key={row.id}
            className={styles.rowSlot}
            style={{
              transform: `translateY(${offsets[first + index]}px)`,
              height: ROW_HEIGHT[row.kind],
            }}
          >
            <Row
              row={row}
              selected={row.kind === "file" && row.file.key === selected}
              editable={editable}
              included={row.kind === "file" && !excluded.has(row.file.key)}
              comments={row.kind === "file" ? (comments.get(row.file.key) ?? 0) : 0}
              findings={findings.get(row.id) ?? 0}
              query={query}
              actions={actions}
            />
          </li>
        ))}
      </ul>
    </div>
  );
});

const Row = memo(function Row({
  row,
  selected,
  editable,
  included,
  comments,
  findings,
  query,
  actions,
}: {
  row: FileRow;
  selected: boolean;
  editable: boolean;
  included: boolean;
  comments: number;
  findings: number;
  query: string;
  actions: FileListActions;
}) {
  const t = useT();
  const checkpoint = useCheckpointSelection();
  if (row.kind === "empty")
    return <p className={styles.listEmpty}>{t("changes.list.noMatch", { query })}</p>;
  if (row.kind === "dir")
    return (
      <button
        type="button"
        className={styles.dirRow}
        aria-expanded={row.open}
        onClick={() => actions.toggleFolder(row.dir, !row.open)}
      >
        <ChangesIcon name={row.open ? "down" : "right"} size={13} className={styles.chevron} />
        <span className={styles.dirName}>{row.dir}/</span>
        {findings > 0 && <FindingBadge count={findings} />}
        <span className={styles.stat}>
          <span className={styles.count}>{formatCount(row.count)}</span>
          {!row.open && !!row.added && (
            <span className={styles.plus}>+{formatCount(row.added)}</span>
          )}
          {!row.open && !!row.removed && (
            <span className={styles.minus}>−{formatCount(row.removed)}</span>
          )}
        </span>
      </button>
    );
  if (row.kind === "more")
    return (
      <button type="button" className={styles.moreRow} onClick={() => actions.showAll(row.dir)}>
        {t("changes.list.more", { count: formatCount(row.remaining) })}
      </button>
    );
  if (row.kind === "generated")
    return (
      <button
        type="button"
        className={styles.generatedRow}
        aria-expanded={row.open}
        onClick={actions.toggleGenerated}
      >
        <ChangesIcon name={row.open ? "down" : "right"} size={13} className={styles.chevron} />
        <span className={styles.dirName}>
          {t("changes.list.generated", { count: formatCount(row.count) })}
        </span>
        <span className={styles.stat}>
          {!!row.added && <span className={styles.plus}>+{formatCount(row.added)}</span>}
          {!!row.removed && <span className={styles.minus}>−{formatCount(row.removed)}</span>}
        </span>
      </button>
    );
  const { file } = row;
  return (
    <div
      className={styles.fileRow}
      data-changed-file={file.display}
      data-nested={row.nested || undefined}
      data-on={selected || undefined}
    >
      {checkpoint && (
        <input
          type="checkbox"
          className={styles.check}
          checked={checkpoint.selected.has(file.key)}
          title={checkpoint.reason(file.key)}
          disabled={checkpoint.disabled || !checkpoint.capable(file.key)}
          aria-label={t("agentWork.restoreFile", { path: file.display })}
          onChange={(event) => checkpoint.toggle(file.key, event.currentTarget.checked)}
        />
      )}
      {editable && (
        <input
          type="checkbox"
          className={styles.check}
          checked={included}
          aria-label={t("changes.list.include", { path: file.display })}
          onChange={(event) => actions.toggleIncluded(file.key, event.currentTarget.checked)}
        />
      )}
      <Tag file={file} />
      <button
        type="button"
        className={styles.fileName}
        aria-current={selected || undefined}
        title={file.display}
        onClick={() => actions.open(file)}
      >
        <span data-deleted={file.tag === "D" || undefined}>
          {row.full ? file.display : baseName(file.display)}
        </span>
        {findings > 0 && <FindingBadge count={findings} />}
        {comments > 0 && (
          <span className={styles.commentBadge} title={t("changes.list.comments")}>
            <ChangesIcon name="comment" size={10} />
            {comments}
          </span>
        )}
      </button>
      <span className={styles.rowStat}>
        <FileStat file={file} />
      </span>
      {actions.revealSource && (
        <PopupMenu label={t("messages.actions")} icon="more">
          <RevealFileButton source={actions.revealSource(file)} className={styles.revealItem} />
        </PopupMenu>
      )}
      {editable && (
        <button
          type="button"
          className={styles.rowAction}
          aria-label={t("changes.discard.file")}
          title={t("changes.discard.file")}
          onClick={() => actions.discard(file)}
        >
          <ChangesIcon name="undo" />
        </button>
      )}
    </div>
  );
});
