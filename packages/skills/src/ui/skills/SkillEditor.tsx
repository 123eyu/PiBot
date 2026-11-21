import type { TranslationKey } from "@pibot/i18n";
import { useT } from "@pibot/renderer-kit";
import {
  parseSkillMarkdown,
  renderSkillMarkdown,
  type SkillDocument,
  type SkillFileChange,
} from "@pibot/skills-contract/full";
import { Button, Icon } from "@pibot/ui";
import { type ReactNode, useId, useState } from "react";
import { sizeText } from "./presentation.ts";
import { SkillFileList } from "./SkillFileList.tsx";
import styles from "./skills.module.css";
import {
  type EditorFile,
  type FileScope,
  newPathIssue,
  type SavedFile,
  useSkillFiles,
} from "./use-skill-files.ts";

const SKILL_FILE = "SKILL.md";

/**
 * Edits a skill package: SKILL.md (front matter + steps) first, then any supporting files, saved
 * together. Shared by the profile and group panels, the chat proposal card and the connections
 * page. Without `initial` it starts from the example; `files` are the saved supporting files.
 */
export function SkillEditor({
  initial,
  files: savedFiles,
  scope,
  botName,
  busy,
  submitLabel,
  children,
  onSubmit,
  onCancel,
}: {
  initial?: SkillDocument;
  files?: readonly SavedFile[];
  scope: FileScope;
  botName: string;
  busy: boolean;
  submitLabel?: string;
  /** Extra content between the text and the buttons (the connections page's 「给谁用」). */
  children?: ReactNode;
  /** `files` is undefined when no supporting file changed. */
  onSubmit(document: SkillDocument, files?: SkillFileChange[]): void;
  onCancel(): void;
}) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(() =>
    initial ? renderSkillMarkdown(initial) : t("skills.editor.template"),
  );
  const pack = useSkillFiles(scope, savedFiles);
  const [selected, setSelected] = useState(SKILL_FILE);
  // Problems are listed only after a save attempt, then follow the text so fixed ones disappear.
  const [checked, setChecked] = useState(false);
  const result = checked ? parseSkillMarkdown(text) : undefined;
  const locked = busy || pack.uploading;
  const select = (path: string) => {
    setSelected(path);
    const file = pack.files.find((item) => item.path === path);
    if (file) void pack.load(file);
  };
  const upload = async (from: "file" | "folder") => {
    const first = await pack.pick(from);
    if (first) setSelected(first);
  };
  const file = pack.files.find((item) => item.path === selected);
  const rows = [
    {
      path: SKILL_FILE,
      bytes: new TextEncoder().encode(text).byteLength,
      script: false,
      text: true,
    },
    ...pack.files,
  ];
  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseSkillMarkdown(text);
        setChecked(true);
        if (parsed.ok) onSubmit(parsed.document, pack.changes());
        else setSelected(SKILL_FILE);
      }}
    >
      <div className={styles.editorLayout}>
        <div className={styles.editorGrid}>
          <div className={styles.editorFiles}>
            <SkillFileList
              files={rows}
              label={t("skills.editor.files")}
              selected={file ? selected : SKILL_FILE}
              onSelect={select}
            />
            <FileActions
              files={pack.files}
              disabled={locked}
              uploading={pack.uploading}
              add={(path) => setSelected(pack.add(path))}
              upload={(from) => void upload(from)}
            />
            {pack.uploadError && (
              <p role="alert" className={styles.error}>
                {t(pack.uploadError)}
              </p>
            )}
          </div>
          {file ? (
            <FilePane
              key={file.path}
              file={file}
              text={pack.textOf(file)}
              loadError={pack.loadError?.path === file.path ? pack.loadError.key : undefined}
              botName={botName}
              disabled={locked}
              edit={(value) => pack.edit(file.path, value)}
              remove={() => {
                pack.remove(file.path);
                setSelected(SKILL_FILE);
              }}
            />
          ) : (
            <label className={`${styles.field} ${styles.editorPane}`}>
              {t("skills.editor.markdown")}
              <textarea
                className={styles.markdown}
                value={text}
                disabled={busy}
                spellCheck={false}
                aria-describedby={`${id}-hint`}
                aria-invalid={result ? !result.ok : undefined}
                onChange={(e) => setText(e.currentTarget.value)}
              />
              <span id={`${id}-hint`}>{t("skills.editor.markdownHint", { bot: botName })}</span>
            </label>
          )}
        </div>
      </div>
      {result && !result.ok && (
        <div role="alert" className={styles.error}>
          {t("skills.editor.issues")}
          <ul className={styles.issues}>
            {result.issues.map((issue) => (
              <li key={issue}>{t(`skills.editor.issue.${issue}`)}</li>
            ))}
          </ul>
        </div>
      )}
      {children}
      <div className={styles.actions}>
        <span className={styles.grow} />
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={pack.uploading}>
          {submitLabel ?? t("common.save")}
        </Button>
      </div>
    </form>
  );
}

/** 「新建文件」 asks for a relative path; 「上传」 goes through brain's picker. */
function FileActions({
  files,
  disabled,
  uploading,
  add,
  upload,
}: {
  files: readonly EditorFile[];
  disabled: boolean;
  uploading: boolean;
  add(path: string): void;
  upload(from: "file" | "folder"): void;
}) {
  const t = useT();
  const id = useId();
  const [path, setPath] = useState<string>();
  const [issue, setIssue] = useState<TranslationKey>();
  const confirm = () => {
    if (path === undefined) return;
    const problem = newPathIssue(files, path);
    setIssue(problem);
    if (problem) return;
    add(path);
    setPath(undefined);
  };
  return (
    <>
      <div className={styles.fileActions}>
        <Button
          variant="pill"
          className={styles.mini}
          disabled={disabled}
          onClick={() => {
            setPath("");
            setIssue(undefined);
          }}
        >
          <Icon name="plus" size={13} /> {t("skills.editor.newFile")}
        </Button>
        <Button
          variant="pill"
          className={styles.mini}
          disabled={disabled}
          loading={uploading}
          onClick={() => upload("file")}
        >
          <Icon name="file" size={13} /> {t("skills.editor.uploadFile")}
        </Button>
        <Button
          variant="pill"
          className={styles.mini}
          disabled={disabled}
          onClick={() => upload("folder")}
        >
          <Icon name="folder" size={13} /> {t("skills.editor.uploadFolder")}
        </Button>
      </div>
      {path !== undefined && (
        <div className={styles.field}>
          <label htmlFor={`${id}-path`}>{t("skills.editor.newPath")}</label>
          <input
            id={`${id}-path`}
            value={path}
            spellCheck={false}
            placeholder="scripts/check.sh"
            aria-describedby={`${id}-hint`}
            aria-invalid={issue ? true : undefined}
            onChange={(e) => {
              setPath(e.currentTarget.value);
              setIssue(undefined);
            }}
            onKeyDown={(event) => {
              // Enter would otherwise submit the whole skill form.
              if (event.key !== "Enter") return;
              event.preventDefault();
              confirm();
            }}
          />
          <span id={`${id}-hint`}>{t("skills.editor.newPathHint")}</span>
          {issue && (
            <span role="alert" className={styles.error}>
              {t(issue)}
            </span>
          )}
          <div className={styles.actions}>
            <Button variant="secondary" className={styles.mini} onClick={confirm}>
              {t("skills.editor.addFile")}
            </Button>
            <Button variant="ghost" className={styles.mini} onClick={() => setPath(undefined)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** One supporting file: text in a box, binary only described; removal is confirmed first. */
function FilePane({
  file,
  text,
  loadError,
  botName,
  disabled,
  edit,
  remove,
}: {
  file: EditorFile;
  text: string | undefined;
  loadError?: TranslationKey;
  botName: string;
  disabled: boolean;
  edit(text: string): void;
  remove(): void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={`${styles.field} ${styles.editorPane}`}>
      <div className={styles.paneHead}>
        <span className={styles.fileName}>{file.path}</span>
        <Button
          variant="ghost"
          className={`${styles.mini} ${styles.danger}`}
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          <Icon name="trash" size={13} /> {t("skills.editor.deleteFile")}
        </Button>
      </div>
      {confirming && (
        <div className={styles.confirm}>
          <p>{t("skills.editor.deleteFileConfirm", { path: file.path })}</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              className={`${styles.mini} ${styles.deleteButton}`}
              onClick={remove}
            >
              {t("skills.delete")}
            </Button>
            <Button variant="ghost" className={styles.mini} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
      {!file.text ? (
        <p className={styles.note}>{t("skills.editor.binary", { size: sizeText(file.bytes) })}</p>
      ) : loadError ? (
        <p role="alert" className={styles.error}>
          {t(loadError)}
        </p>
      ) : text === undefined ? (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      ) : (
        <textarea
          className={styles.markdown}
          value={text}
          disabled={disabled}
          spellCheck={false}
          aria-label={t("skills.editor.fileText", { path: file.path })}
          onChange={(e) => edit(e.currentTarget.value)}
        />
      )}
      {file.script && (
        <p className={styles.note}>{t("skills.editor.scriptNote", { bot: botName })}</p>
      )}
    </div>
  );
}
