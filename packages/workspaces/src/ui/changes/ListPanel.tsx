import { useT } from "@pibot/renderer-kit";
import { useMemo } from "react";
import styles from "./changes.module.css";
import { FileList, type FileListActions, formatCount, pluralCount } from "./diff/FileList.tsx";
import { type FileRow, rowOffsets } from "./diff/file-rows.ts";
import { ChangesIcon } from "./icons.tsx";
import { type FileTag, type ListFile, sumLines, TAG_LABEL } from "./model.ts";

const SUMMARY_TAGS: FileTag[] = ["M", "A", "D", "C", "T", "X"];

/** Summary, filter / layout toggle and the virtual file list for one scope. */
export function ListPanel({
  files,
  rows,
  matched,
  query,
  setQuery,
  tree,
  setTree,
  selected,
  editable,
  excluded,
  comments,
  findings,
  actions,
}: {
  files: readonly ListFile[];
  rows: readonly FileRow[];
  matched: number;
  query: string;
  setQuery(query: string): void;
  tree: boolean;
  setTree(tree: boolean): void;
  selected?: string;
  editable: boolean;
  excluded: ReadonlySet<string>;
  comments: ReadonlyMap<string, number>;
  findings: ReadonlyMap<string, number>;
  actions: FileListActions;
}) {
  const t = useT();
  const offsets = useMemo(() => rowOffsets(rows), [rows]);
  const summary = useMemo(() => {
    const counts = new Map<FileTag, number>();
    for (const file of files) {
      const tag = file.tag === "U" ? "A" : file.tag;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return { ...sumLines(files), counts };
  }, [files]);
  return (
    <>
      <div className={styles.summary}>
        <b>{t("changes.list.files", { count: pluralCount(files.length) })}</b>
        {!!summary.added && <span className={styles.plus}>+{formatCount(summary.added)}</span>}
        {!!summary.removed && <span className={styles.minus}>−{formatCount(summary.removed)}</span>}
        <span className={styles.dist}>
          {SUMMARY_TAGS.filter((tag) => summary.counts.get(tag))
            .map((tag) => `${t(TAG_LABEL[tag])} ${formatCount(summary.counts.get(tag) ?? 0)}`)
            .join(" · ")}
        </span>
        {query.trim() && matched !== files.length && (
          <span className={styles.dist}>
            {t("changes.list.matched", { count: formatCount(matched) })}
          </span>
        )}
      </div>
      <div className={styles.tools}>
        <label className={styles.search}>
          <span className={styles.visuallyHidden}>{t("changes.list.filter")}</span>
          <input
            type="search"
            value={query}
            placeholder={t("changes.list.filterPlaceholder")}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <fieldset className={styles.layoutToggle}>
          <legend className={styles.visuallyHidden}>{t("changes.list.layout")}</legend>
          <button
            type="button"
            aria-pressed={tree}
            aria-label={t("changes.list.byFolder")}
            title={t("changes.list.byFolder")}
            onClick={() => setTree(true)}
          >
            <ChangesIcon name="tree" />
          </button>
          <button
            type="button"
            aria-pressed={!tree}
            aria-label={t("changes.list.flat")}
            title={t("changes.list.flat")}
            onClick={() => setTree(false)}
          >
            <ChangesIcon name="flat" />
          </button>
        </fieldset>
      </div>
      <FileList
        rows={rows}
        offsets={offsets}
        selected={selected}
        editable={editable}
        excluded={excluded}
        comments={comments}
        findings={findings}
        query={query}
        actions={actions}
      />
    </>
  );
}
