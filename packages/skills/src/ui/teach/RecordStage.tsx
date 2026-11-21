import type { TranslationKey } from "@pibot/i18n";
import { type Peer, useT } from "@pibot/renderer-kit";
import type { Recording } from "@pibot/skills-contract/full";
import { Button, TextField } from "@pibot/ui";
import { useEffect, useState } from "react";
import { useSkillsPorts } from "../shell/ports.tsx";
import { StepList } from "./StepList.tsx";
import { elapsedText } from "./step-text.ts";
import styles from "./teach.module.css";
import type { useTeach } from "./use-teach.ts";

type Teach = ReturnType<typeof useTeach>;

/** Step 1 before recording: where to start (the user types it, so no site prompt). */
export function StartForm({ teach, botName }: { teach: Teach; botName: string }) {
  const t = useT();
  const [url, setUrl] = useState(teach.snap.url);
  return (
    <form
      className={styles.card}
      onSubmit={(event) => {
        event.preventDefault();
        if (url.trim()) void teach.start(url);
      }}
    >
      <h2 className={styles.cardTitle}>{t("teach.startTitle")}</h2>
      <p className={styles.note}>{t("teach.startNote", { name: botName })}</p>
      <TextField
        label={t("teach.url")}
        placeholder={t("teach.urlPlaceholder")}
        value={url}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setUrl(event.target.value)}
      />
      <div className={styles.actions}>
        <Button
          type="submit"
          loading={teach.busy === "start"}
          disabled={!url.trim() || !!teach.busy}
        >
          {t("teach.start")}
        </Button>
      </div>
    </form>
  );
}

const RESUME_NOTE: Partial<Record<Recording["status"], TranslationKey>> = {
  recording: "teach.resumeRecording",
  review: "teach.resumeReview",
  drafted: "teach.resumeDrafted",
};

/** On entry, brain still has an unfinished recording this page did not leave off at. */
export function ResumePrompt({ teach, botName }: { teach: Teach; botName: string }) {
  const t = useT();
  const { recording } = teach.snap;
  if (!recording) return null;
  const note = RESUME_NOTE[recording.status] ?? "teach.resumeReview";
  return (
    <section className={styles.card} aria-label={t("teach.resumeTitle")}>
      <h2 className={styles.cardTitle}>{t("teach.resumeTitle")}</h2>
      <p className={styles.note}>{t(note, { name: botName, count: recording.steps.length })}</p>
      <p className={styles.note}>{t("teach.resumeNote")}</p>
      <div className={styles.actions}>
        <span className={styles.spacer} />
        <Button
          variant="ghost"
          loading={teach.busy === "restart"}
          disabled={!!teach.busy}
          onClick={teach.restart}
        >
          {t("teach.resumeRestart")}
        </Button>
        <Button
          loading={teach.busy === "resume"}
          disabled={!!teach.busy}
          onClick={teach.continueLast}
        >
          {t("teach.resumeContinue")}
        </Button>
      </div>
    </section>
  );
}

/** Recording (design 录制): indicator strip, the Bot browser under takeover, the live steps. */
export function RecordingView({
  teach,
  peer,
  botId,
  botName,
}: {
  teach: Teach;
  peer: Peer;
  botId: string;
  botName: string;
}) {
  const { BrowserPane } = useSkillsPorts();
  const t = useT();
  const { recording, paused, startedAt } = teach.snap;
  const [now, setNow] = useState(() => Date.now());
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!recording) return null;
  const time = elapsedText(now - (startedAt ?? now));
  return (
    <div className={styles.recording}>
      <div className={styles.strip} role="status">
        <span
          className={`${styles.recDot} ${paused ? styles.recDotPaused : ""}`}
          aria-hidden="true"
        />
        <span className={styles.stripText}>
          {paused
            ? t("teach.paused", { time })
            : t("teach.recording", { time, count: recording.steps.length })}
        </span>
        <button
          type="button"
          className={styles.stripButton}
          disabled={!!teach.busy}
          onClick={teach.pause}
        >
          {t(paused ? "teach.resume" : "teach.pause")}
        </button>
        <button
          type="button"
          className={styles.stripButton}
          disabled={!!teach.busy}
          onClick={() => setConfirm(true)}
        >
          {t("teach.cancel")}
        </button>
        <button
          type="button"
          className={styles.stripPrimary}
          disabled={!!teach.busy}
          onClick={teach.finish}
        >
          {t("teach.finish")}
        </button>
      </div>
      {confirm && (
        <div className={styles.confirm} role="alertdialog" aria-label={t("teach.discardConfirm")}>
          <span>{t("teach.discardConfirm")}</span>
          <Button variant="secondary" onClick={() => setConfirm(false)}>
            {t("teach.keep")}
          </Button>
          <Button
            variant="primary"
            loading={teach.busy === "discard"}
            onClick={() => {
              setConfirm(false);
              teach.discard(true);
            }}
          >
            {t("teach.discardYes")}
          </Button>
        </div>
      )}
      <div className={styles.recordBody}>
        <div className={styles.browser}>
          <BrowserPane botId={botId} botName={botName} peer={peer} wide teaching />
        </div>
        <aside className={styles.liveSteps} aria-label={t("teach.steps")}>
          <h2 className={styles.asideTitle}>{t("teach.steps")}</h2>
          {recording.steps.length ? (
            <StepList peer={peer} recordingId={recording.id} steps={recording.steps} />
          ) : (
            <p className={styles.note}>{t("teach.noSteps")}</p>
          )}
          <p className={styles.note}>{t("teach.pauseNote")}</p>
          <p className={styles.note}>{t("teach.limit")}</p>
        </aside>
      </div>
    </div>
  );
}

/** After stopping: delete steps before anything reaches the model. */
export function ReviewStage({
  teach,
  peer,
  botName,
}: {
  teach: Teach;
  peer: Peer;
  botName: string;
}) {
  const t = useT();
  const { recording, removed } = teach.snap;
  if (!recording) return null;
  const total = recording.steps.length;
  const kept = total - removed.length;
  // Brain only re-drafts a drafted recording with all its kept steps; removing more needs a new one.
  const editable = recording.status === "review";
  if (teach.busy === "draft")
    return (
      <p className={styles.card} role="status">
        {t("teach.drafting", { name: botName })}
      </p>
    );
  return (
    <section className={styles.card} aria-label={t("teach.reviewTitle")}>
      <h2 className={styles.cardTitle}>{t("teach.reviewTitle")}</h2>
      <p className={styles.note}>{t("teach.reviewNote")}</p>
      {total ? (
        <StepList
          peer={peer}
          recordingId={recording.id}
          steps={recording.steps}
          removed={removed}
          {...(editable ? { onToggle: teach.toggleStep } : {})}
        />
      ) : (
        <p className={styles.note}>{t("teach.emptyRecording")}</p>
      )}
      <div className={styles.actions}>
        {total > 0 && <span className={styles.note}>{t("teach.keptCount", { kept, total })}</span>}
        <span className={styles.spacer} />
        <Button variant="ghost" disabled={!!teach.busy} onClick={() => teach.discard(false)}>
          {t("teach.rerecord")}
        </Button>
        <Button disabled={!kept || !!teach.busy} onClick={teach.draftIt}>
          {t("teach.draftIt")}
        </Button>
      </div>
    </section>
  );
}
