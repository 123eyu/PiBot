import type { TranslationKey } from "@pibot/i18n";
import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { type CSSProperties, useState } from "react";
import { type FileRow, fileTree, sizeText, skillError, type TreeRow } from "./presentation.ts";
import styles from "./skills.module.css";

const depthStyle = (depth: number) => ({ "--depth": depth }) as CSSProperties;
const SKILL_FILE = "SKILL.md";
// A 13k-file package took 5–25 s to open because every row was rendered at once.
// The list is a preview, not a file manager, so cap the rows and state the remainder.
const MAX_ROWS = 200;

/**
 * Files of a skill package: an indented tree, or (`flat`) full paths; SKILL.md always comes first.
 * With `load`, each text file opens inline exactly as it will be saved, so nothing in an import is
 * hidden from the user. With `onSelect` (the editor), a file row picks the file to edit instead.
 */
export function SkillFileList({
  files,
  label,
  flat,
  load,
  selected,
  onSelect,
}: {
  files: readonly FileRow[];
  label: string;
  flat?: boolean;
  load?(path: string): Promise<string | null>;
  selected?: string;
  onSelect?(path: string): void;
}) {
  const t = useT();
  const [open, setOpen] = useState<string>();
  const [texts, setTexts] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [error, setError] = useState<{ path: string; key: TranslationKey }>();
  const skill = files.find((file) => file.path === SKILL_FILE);
  const rest = skill ? files.filter((file) => file !== skill) : files;
  const rows: TreeRow[] = [
    ...(skill ? [{ ...skill, kind: "file" as const, name: SKILL_FILE, depth: 0 }] : []),
    ...(flat
      ? rest.map((file) => ({ ...file, kind: "file" as const, name: file.path, depth: 0 }))
      : fileTree(rest)),
  ];
  const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  const hidden = rows.length - shown.length;
  const toggle = async (path: string) => {
    if (open === path) {
      setOpen(undefined);
      return;
    }
    setOpen(path);
    setError(undefined);
    if (!load || texts.has(path)) return;
    try {
      const text = await load(path);
      setTexts((old) => new Map(old).set(path, text));
    } catch (failure) {
      setError({ path, key: skillError(failure) });
    }
  };
  const fileLine = (row: FileRow & { name: string }) => (
    <>
      <Icon name={row.script ? "terminal" : "file"} size={13} className={styles.fileIcon} />
      <span className={styles.fileName}>{row.name}</span>
      {row.script && <span className={styles.tag}>{t("skills.import.scriptTag")}</span>}
      {onSelect && row.text === false && (
        <span className={styles.tag}>{t("skills.editor.binaryTag")}</span>
      )}
      <span className={styles.fileSize}>{sizeText(row.bytes)}</span>
    </>
  );
  return (
    <ul className={styles.files} aria-label={label}>
      {shown.map((row) =>
        row.kind === "dir" ? (
          <li key={`dir:${row.path}`} className={styles.fileDir} style={depthStyle(row.depth)}>
            <Icon name="folder" size={13} className={styles.fileIcon} />
            <span className={styles.fileName}>{row.name}/</span>
          </li>
        ) : onSelect ? (
          <li key={row.path} className={styles.fileItem} style={depthStyle(row.depth)}>
            <button
              type="button"
              className={`${styles.fileRow} ${styles.filePick}`}
              aria-current={selected === row.path ? "true" : undefined}
              onClick={() => onSelect(row.path)}
            >
              {fileLine(row)}
            </button>
          </li>
        ) : (
          <li key={row.path} className={styles.fileItem} style={depthStyle(row.depth)}>
            <div className={styles.fileRow}>
              {fileLine(row)}
              {load && row.text && (
                <Button
                  variant="pill"
                  aria-expanded={open === row.path}
                  onClick={() => void toggle(row.path)}
                >
                  {t(open === row.path ? "skills.import.hide" : "skills.import.view")}
                </Button>
              )}
            </div>
            {load && row.text === false && row.script && (
              <p className={styles.fileNote}>{t("skills.import.binaryProgram")}</p>
            )}
            {open === row.path &&
              (error?.path === row.path ? (
                <p role="alert" className={styles.error}>
                  {t(error.key)}
                </p>
              ) : (
                <pre className={styles.body}>
                  {texts.has(row.path)
                    ? (texts.get(row.path) ?? t("skills.import.binary"))
                    : t("common.loading")}
                </pre>
              ))}
          </li>
        ),
      )}
      {hidden > 0 && (
        <li className={styles.fileNote}>{t("skills.detail.filesMore", { count: hidden })}</li>
      )}
    </ul>
  );
}
