import type { ComputerStep } from "@pibot/computer-use-contract/full";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import styles from "../computer.module.css";
import {
  stepIcon,
  stepMethodKey,
  stepStatusKey,
  stepStatusTone,
  stepTitle,
  stepTone,
} from "../presentation.ts";
import { ScreenshotViewer } from "./ScreenshotViewer.tsx";
import { StepThumbnail } from "./StepThumbnail.tsx";

export function StepRow({ step, extra }: { step: ComputerStep; extra?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const title = stepTitle(step, t);
  const tone = stepTone(step);
  const tag =
    tone === "browser"
      ? t("computerUse.method.browser")
      : t("computerUse.step.tag", {
          app: step.app.name,
          stage: t(`computerUse.stage.${step.stage}`),
          method: t(stepMethodKey(step)),
        });
  const body = (
    <>
      <StepThumbnail stepId={step.id} available={step.hasScreenshot} icon={stepIcon(step)} />
      <span className={styles.stepText}>
        <span>{title}</span>
        {step.page && (step.page.title || step.page.url) && (
          // Which page the step left the Bot on; the full address on hover.
          <span className={styles.stepPage}>
            {/* A page without a title reports its address as the title; show it once. */}
            {step.page.title && step.page.title !== step.page.url && (
              <span className={styles.stepPageTitle} title={step.page.title}>
                {step.page.title}
              </span>
            )}
            {step.page.url && (
              <span className={styles.stepPageUrl} title={step.page.url}>
                {step.page.url}
              </span>
            )}
          </span>
        )}
        <span>
          <span className={styles.tag} data-tone={tone}>
            {tag}
          </span>
          {extra && <span className={styles.inlineNote}>{extra}</span>}
        </span>
      </span>
      <span className={styles.stepStatus} data-result={stepStatusTone(step)}>
        {t(stepStatusKey(step))}
      </span>
    </>
  );
  return (
    <>
      {step.hasScreenshot ? (
        <button
          type="button"
          className={styles.stepRow}
          aria-label={t("computerUse.step.view", { step: title })}
          onClick={() => setOpen(true)}
        >
          {body}
        </button>
      ) : (
        <div className={styles.stepRow}>{body}</div>
      )}
      {open && <ScreenshotViewer step={step} onClose={() => setOpen(false)} />}
    </>
  );
}

export function StepList({
  steps,
  error,
  retry,
}: {
  steps: ComputerStep[];
  error?: boolean;
  retry?: () => void;
}) {
  const t = useT();
  if (!steps.length && !error) return null;
  return (
    <div className={styles.steps}>
      {steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
      {error && (
        <p role="alert" className={styles.stepsError}>
          {t("computerUse.steps.loadError")}
          {retry && (
            <Button variant="ghost" onClick={retry}>
              {t("common.retry")}
            </Button>
          )}
        </p>
      )}
    </div>
  );
}
