import { type Peer, useT } from "@pibot/renderer-kit";
import type { TeachStep } from "@pibot/skills-contract/full";
import { CloseButton, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { stepSite, stepText } from "./step-text.ts";
import styles from "./teach.module.css";

/** Small LRU of thumbnail data URLs; a step's picture changes while it is still being typed. */
const pictures = new Map<string, string | null>();
const MAX_PICTURES = 200;
function remember(key: string, value: string | null) {
  pictures.delete(key);
  pictures.set(key, value);
  if (pictures.size > MAX_PICTURES) pictures.delete(pictures.keys().next().value as string);
}

function Thumbnail({
  peer,
  recordingId,
  step,
}: {
  peer: Peer;
  recordingId: string;
  step: TeachStep;
}) {
  const t = useT();
  const key = `${recordingId}:${step.index}:${step.at}:${step.hasThumbnail}`;
  const [src, setSrc] = useState(() => pictures.get(key));
  useEffect(() => {
    if (!step.hasThumbnail) return;
    const known = pictures.get(key);
    if (known !== undefined) {
      setSrc(known);
      return;
    }
    let live = true;
    // Fetched one at a time on demand; pictures never ride along with the step list.
    void peer
      .call("teach.thumbnail", { recordingId, index: step.index })
      .then((image) => `data:${image.mimeType};base64,${image.data}`)
      .catch(() => null)
      .then((value) => {
        remember(key, value);
        if (live) setSrc(value);
      });
    return () => {
      live = false;
    };
  }, [peer, recordingId, step.index, step.hasThumbnail, key]);
  const [open, setOpen] = useState(false);
  const label = t("teach.thumbnail", { n: step.index + 1 });
  // The keyframe is a 480 px page shot; a row-sized copy is a hint, the click shows it whole.
  return src ? (
    <>
      <button
        type="button"
        className={styles.thumbButton}
        aria-label={t("teach.thumbnailOpen", { n: step.index + 1 })}
        title={t("teach.thumbnailOpen", { n: step.index + 1 })}
        onClick={() => setOpen(true)}
      >
        <img className={styles.thumb} src={src} alt={label} loading="lazy" />
      </button>
      {open && <ThumbnailViewer src={src} label={label} onClose={() => setOpen(false)} />}
    </>
  ) : (
    <span className={styles.thumb} role="img" aria-label={t("teach.error.thumbnail")} />
  );
}

function ThumbnailViewer({ src, label, onClose }: { src: string; label: string; onClose(): void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className={styles.viewer} aria-label={label} onClose={onClose}>
      <div className={styles.viewerHeader}>
        <strong>{label}</strong>
        <CloseButton label={t("attachments.close")} onClick={() => dialog.current?.close()} />
      </div>
      <img className={styles.viewerImage} src={src} alt={label} />
    </dialog>
  );
}

export function StepList({
  peer,
  recordingId,
  steps,
  removed,
  onToggle,
}: {
  peer: Peer;
  recordingId: string;
  steps: readonly TeachStep[];
  /** Review mode when given: each row can be removed or restored. */
  removed?: readonly number[];
  onToggle?(index: number): void;
}) {
  const t = useT();
  return (
    <ol className={styles.steps}>
      {steps.map((step) => {
        const gone = removed?.includes(step.index) ?? false;
        const site = stepSite(step);
        return (
          <li key={step.index} className={`${styles.step} ${gone ? styles.stepGone : ""}`}>
            <span className={styles.stepNo}>{step.index + 1}</span>
            <Thumbnail peer={peer} recordingId={recordingId} step={step} />
            <span className={styles.stepMain}>
              <span className={styles.stepText}>
                {gone ? t("teach.removed") : stepText(t, step)}
              </span>
              {site && !gone && <span className={styles.site}>{site}</span>}
            </span>
            {onToggle && (
              <button
                type="button"
                className={styles.stepToggle}
                aria-label={t(gone ? "teach.restoreStep" : "teach.removeStep", {
                  n: step.index + 1,
                })}
                title={t(gone ? "teach.restoreStep" : "teach.removeStep", { n: step.index + 1 })}
                onClick={() => onToggle(step.index)}
              >
                <Icon name={gone ? "plus" : "trash"} size={16} />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
