import { useT } from "@pibot/renderer-kit";
import type { ChangesDiff, DiffHunk, ReviewFinding } from "@pibot/workspaces-contract/full";
import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "../changes.module.css";
import { ChangesIcon } from "../icons.tsx";
import { baseName, dirName, isImage, type ListFile } from "../model.ts";
import { CommentCard, CommentEditor } from "../review/CommentParts.tsx";
import type { CommentAnchor, DraftComment } from "../review/comments.ts";
import { type FindingActions, FindingCard } from "../review/ReviewParts.tsx";
import type { Expansion } from "../use-expansion.ts";
import { Hunks } from "./DiffHunks.tsx";
import { FileStat, formatCount, Tag } from "./FileList.tsx";
import { ImageCompare, type ImageLoader } from "./ImageCompare.tsx";
import { OfficeChanges } from "./OfficeChanges.tsx";

/** One file over 400 changed lines starts collapsed. */
const LARGE_LINES = 400;
const HINT_KEY = "pibot.changes.commentHint";

export interface DiffState {
  data?: ChangesDiff;
  loading: boolean;
  error?: boolean;
}
export interface DiffActions {
  back?(): void;
  step(delta: -1 | 1): void;
  line(side: "new" | "old", line: number, extend: boolean): void;
  fileComment(): void;
  saveComment(text: string): void;
  cancelComment(): void;
  deleteComment(id: string): void;
  discardFile?(): void;
  discardHunk?(hunk: DiffHunk): void;
  /** Takes one object of a Word / Excel / PowerPoint file back to the earlier version. */
  discardOffice?(item: string, digest: string): void;
  openFile?(): void;
  /** "This turn" files the preview pane can show. */
  previewFile?(): void;
  retry(): void;
  /** "Ignore" / "Fix this" on review findings. */
  finding: FindingActions;
}

function readHint() {
  try {
    return localStorage.getItem(HINT_KEY) !== "closed";
  } catch {
    return true; // Storage blocked: showing the one-line hint again is harmless.
  }
}

export function DiffView({
  file,
  state,
  index,
  total,
  wide,
  commentable,
  editable,
  writable,
  stale = false,
  rootLabel,
  comments,
  editing,
  botName,
  reviewerName,
  findings,
  revealFinding = 0,
  busy,
  expansion,
  loadImage,
  actions,
}: {
  file: ListFile;
  state: DiffState;
  index: number;
  total: number;
  wide: boolean;
  commentable: boolean;
  editable: boolean;
  /** The folder can be written now even when this scope is a past turn or commit. */
  writable: boolean;
  /** The document changed outside the panel since this list was built. */
  stale?: boolean;
  rootLabel: string;
  comments: readonly DraftComment[];
  editing?: CommentAnchor;
  botName: string;
  /** Who reviewed, when another Bot did. */
  reviewerName?: string;
  /** Open review findings of this file. */
  findings: readonly ReviewFinding[];
  /** Changes when the reader asked to jump to the first finding. */
  revealFinding?: number;
  busy: boolean;
  expansion?: Expansion;
  loadImage?: ImageLoader;
  actions: DiffActions;
}) {
  const t = useT();
  const [wrap, setWrap] = useState(false);
  const [hint, setHint] = useState(readHint);
  const [showLarge, setShowLarge] = useState(false);
  const [showGenerated, setShowGenerated] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: collapse again for each new file
  useEffect(() => {
    setShowLarge(false);
    setShowGenerated(false);
  }, [file.key]);
  const data = state.data;
  const changed = (data?.added ?? file.added ?? 0) + (data?.removed ?? file.removed ?? 0);
  const folder = dirName(file.display) || rootLabel;
  const fileComments = comments.filter((comment) => comment.side === "file");
  const editingHere = editing?.fileKey === file.key ? editing : undefined;
  let body: ReactNode;
  let hunksShown = false;
  if (file.command) body = <Banner text={t("changes.diff.command")} action={actions.openFile} />;
  else if (state.error)
    body = (
      <Banner
        text={t("changes.diff.error")}
        action={actions.retry}
        actionLabel={t("common.retry")}
      />
    );
  else if (!data)
    body = (
      <div className={styles.skeleton} role="status" aria-label={t("common.loading")}>
        <i style={{ width: "40%" }} />
        <i style={{ width: "82%" }} />
        <i style={{ width: "66%" }} />
      </div>
    );
  else if (data.unavailable === "command")
    body = <Banner text={t("changes.diff.command")} action={actions.openFile} />;
  else if (data.unavailable === "snapshot_missing")
    body = <Banner text={t("changes.diff.snapshotMissing")} />;
  else if (data.binary || file.binary)
    body = data.office ? (
      <OfficeChanges
        data={data.office}
        editable={writable}
        stale={stale}
        discard={
          actions.discardOffice
            ? (item) => actions.discardOffice?.(item.id, data.office?.digest ?? "")
            : undefined
        }
        discardFile={writable ? actions.discardFile : undefined}
      />
    ) : isImage(file.display) ? (
      <ImageCompare file={file} load={loadImage} openFile={actions.openFile} />
    ) : (
      <Banner text={t("changes.diff.binary")} action={actions.openFile} />
    );
  else if (data.tooLarge)
    body = (
      <Banner
        text={t("changes.diff.tooLarge", { count: formatCount(changed) })}
        action={actions.openFile}
      />
    );
  else if (file.generated && !showGenerated)
    body = (
      <Banner
        text={t("changes.diff.generated", {
          name: baseName(file.display),
          count: formatCount(changed),
        })}
        action={() => setShowGenerated(true)}
        actionLabel={t("changes.diff.showAnyway")}
      />
    );
  else if (changed > LARGE_LINES && !showLarge)
    body = (
      <Banner
        text={t("changes.diff.large", { count: formatCount(changed) })}
        action={() => setShowLarge(true)}
        actionLabel={t("changes.diff.showAll")}
      />
    );
  else if (!data.hunks.length) body = <Banner text={t("changes.diff.noText")} />;
  else {
    hunksShown = true;
    body = (
      <Hunks
        file={file}
        hunks={data.hunks}
        hunkDiscard={editable && file.tag === "M" ? actions.discardHunk : undefined}
        notes={{
          commentable,
          comments,
          editing: editingHere,
          findings,
          botName,
          ...(reviewerName ? { reviewerName } : {}),
          busy,
          actions,
        }}
        expansion={expansion}
      />
    );
  }
  // Hunks place findings on their lines; any other body lists the file's findings above it.
  const topFindings = hunksShown ? [] : findings;
  // "Click a line number" means nothing for a file with no lines on screen (written by a command,
  // binary, too large, collapsed); its comment button above still comments on the whole file.
  // While the diff loads the hint stays, since most files do have lines.
  const lineless = file.command || !file.diffAvailable || (!!data && !hunksShown);
  const scroller = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  // Opening the file alone left a finding further down off-screen. Each request is consumed once,
  // after the diff body is there, so later visits to the file keep their own scroll position.
  useEffect(() => {
    if (!revealFinding || revealed.current === revealFinding || !data) return;
    const card = scroller.current?.querySelector("[data-finding]");
    if (!card) return;
    revealed.current = revealFinding;
    card.scrollIntoView({ block: "center" });
  }, [revealFinding, data]);
  return (
    <section className={styles.diff} aria-label={file.display}>
      <header className={styles.diffHead}>
        {!wide && actions.back && (
          <button
            type="button"
            className={styles.iconGhost}
            aria-label={t("changes.diff.back")}
            title={t("changes.diff.back")}
            onClick={actions.back}
          >
            <ChangesIcon name="back" />
          </button>
        )}
        <Tag file={file} />
        <div className={styles.diffPath}>
          <b title={file.display}>{baseName(file.display)}</b>
          <span>
            {folder} · <FileStat file={file} />
          </span>
        </div>
        {commentable && (
          <button
            type="button"
            className={styles.iconGhost}
            aria-label={t("changes.comment.fileAction")}
            title={t("changes.comment.fileAction")}
            onClick={actions.fileComment}
          >
            <ChangesIcon name="comment" />
          </button>
        )}
        <button
          type="button"
          className={styles.iconGhost}
          aria-pressed={wrap}
          aria-label={t("changes.diff.wrap")}
          title={t("changes.diff.wrap")}
          onClick={() => setWrap((value) => !value)}
        >
          <ChangesIcon name="wrap" />
        </button>
        {actions.previewFile && (
          <button
            type="button"
            className={styles.iconGhost}
            aria-label={t("changes.diff.preview")}
            title={t("changes.diff.preview")}
            onClick={actions.previewFile}
          >
            <ChangesIcon name="eye" />
          </button>
        )}
        {actions.openFile && (
          <button
            type="button"
            className={styles.iconGhost}
            aria-label={t("changes.diff.open")}
            title={t("changes.diff.open")}
            onClick={actions.openFile}
          >
            <ChangesIcon name="open" />
          </button>
        )}
        {editable && actions.discardFile && (
          <button
            type="button"
            className={styles.iconGhost}
            aria-label={t("changes.discard.file")}
            title={t("changes.discard.file")}
            onClick={actions.discardFile}
          >
            <ChangesIcon name="undo" />
          </button>
        )}
        <span className={styles.position}>
          {index + 1} / {total}
        </span>
        <button
          type="button"
          className={styles.iconGhost}
          aria-label={t("changes.diff.previous")}
          title={t("changes.diff.previous")}
          disabled={index <= 0}
          onClick={() => actions.step(-1)}
        >
          <ChangesIcon name="up" />
        </button>
        <button
          type="button"
          className={styles.iconGhost}
          aria-label={t("changes.diff.next")}
          title={t("changes.diff.next")}
          disabled={index >= total - 1}
          onClick={() => actions.step(1)}
        >
          <ChangesIcon name="down" />
        </button>
      </header>
      <div ref={scroller} className={styles.diffScroll} data-wrap={wrap || undefined}>
        {commentable && hint && !lineless && (
          <div className={styles.bannerAccent}>
            <ChangesIcon name="comment" />
            <span>{t("changes.comment.hint", { name: botName })}</span>
            <button
              type="button"
              className={styles.iconGhostSmall}
              aria-label={t("changes.comment.hintClose")}
              onClick={() => {
                setHint(false);
                try {
                  localStorage.setItem(HINT_KEY, "closed");
                } catch {
                  // The hint simply returns next time when storage is unavailable.
                }
              }}
            >
              <ChangesIcon name="plus" style={{ transform: "rotate(45deg)" }} />
            </button>
          </div>
        )}
        {fileComments.map((comment) => (
          <CommentCard key={comment.id} comment={comment} onDelete={actions.deleteComment} />
        ))}
        {editingHere?.side === "file" && (
          <CommentEditor
            anchor={editingHere}
            botName={botName}
            onSave={actions.saveComment}
            onCancel={actions.cancelComment}
          />
        )}
        {topFindings.map((item) => (
          <FindingCard
            key={item.id}
            finding={item}
            botName={reviewerName ?? botName}
            actions={actions.finding}
            busy={busy}
            showRef
          />
        ))}
        {body}
      </div>
    </section>
  );
}

function Banner({
  text,
  action,
  actionLabel,
}: {
  text: string;
  action?: () => void;
  actionLabel?: string;
}) {
  const t = useT();
  return (
    <div className={styles.bannerInfo}>
      <span>{text}</span>
      {action && (
        <button type="button" className={styles.miniAccent} onClick={action}>
          {actionLabel ?? t("changes.diff.open")}
        </button>
      )}
    </div>
  );
}
