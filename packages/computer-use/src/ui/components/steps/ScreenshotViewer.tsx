import type { ComputerStep } from "@pibot/computer-use-contract/full";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, CloseButton } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../computer.module.css";
import {
  clickPoint,
  computerErrorKey,
  stepMethodKey,
  stepTitle,
  stepTone,
} from "../presentation.ts";

/**
 * Full screenshot for one step, fetched only while open and dropped on close (never cached),
 * with the click position marked for coordinate steps.
 */
export function ScreenshotViewer({ step, onClose }: { step: ComputerStep; onClose(): void }) {
  const t = useT();
  const { peer } = useRpc();
  const dialog = useRef<HTMLDialogElement>(null);
  const [image, setImage] = useState<{ source: string; width: number; height: number }>();
  const [source, setSource] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const [attempt, setAttempt] = useState(0);
  const point = clickPoint(step);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit retry trigger
  useEffect(() => {
    if (!peer) return;
    let active = true;
    setError(undefined);
    setSource(undefined);
    setImage(undefined);
    peer
      .call("computer.screenshot.view", { stepId: step.id })
      .then((result) => {
        if (active) setSource(`data:${result.mimeType};base64,${result.data}`);
      })
      .catch((e: unknown) => {
        if (active) setError(computerErrorKey(e));
      });
    return () => {
      active = false;
    };
  }, [peer, step.id, attempt]);
  const title = stepTitle(step, t);
  return (
    <dialog
      ref={dialog}
      className={styles.viewer}
      aria-label={t("computerUse.viewer.title")}
      onClose={onClose}
    >
      <div className={styles.viewerHeader}>
        <strong>{title}</strong>
        <CloseButton label={t("attachments.close")} onClick={() => dialog.current?.close()} />
      </div>
      <div className={styles.frame}>
        {source ? (
          <span className={styles.frameInner}>
            <img
              src={source}
              alt={title}
              onLoad={(event) =>
                setImage({
                  source,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => setError("computerUse.error.failed")}
            />
            {point && image?.source === source && image.width > 0 && image.height > 0 && (
              <span
                className={styles.mark}
                style={{
                  left: `${Math.min(100, (point.x / image.width) * 100)}%`,
                  top: `${Math.min(100, (point.y / image.height) * 100)}%`,
                }}
              />
            )}
          </span>
        ) : error ? (
          <span role="alert" className={styles.stepsError}>
            {t(error)}
            <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
              {t("common.retry")}
            </Button>
          </span>
        ) : (
          <span role="status">{t("common.loading")}</span>
        )}
      </div>
      <div className={styles.viewerFacts}>
        <span className={styles.tag} data-tone={stepTone(step)}>
          {[step.app.name, t(`computerUse.stage.${step.stage}`), t(stepMethodKey(step))].join(
            " · ",
          )}
        </span>
        {point && (
          <span className={styles.tag}>
            {t("computerUse.viewer.click", { x: point.x, y: point.y })}
          </span>
        )}
      </div>
      <p>
        {t(
          step.method === "browser" ? "computerUse.viewer.browserNote" : "computerUse.viewer.note",
        )}
      </p>
      <div className={styles.viewerActions}>
        <Button variant="secondary" onClick={() => dialog.current?.close()}>
          {t("attachments.close")}
        </Button>
      </div>
    </dialog>
  );
}
