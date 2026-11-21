import type { DesktopUpdateState } from "@pibot/protocol";
import { useRpc, useSettings, useT } from "@pibot/renderer-kit";
import { Button, type DotState, Logo, StatusDot } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { openWebsite } from "./AppPanels.tsx";
import styles from "./app-menu.module.css";
import notesStyles from "./update-notes.module.css";
import { useUpdates } from "./updates.tsx";

/** The update message leads with a state dot (checking breathes, ready is green, failed red). */
const phaseDot: Record<DesktopUpdateState["phase"], DotState> = {
  idle: "running",
  checking: "running",
  current: "done",
  available: "waiting",
  downloading: "running",
  downloaded: "done",
  installing: "running",
  error: "failed",
};

/** Message, progress and actions for one update state; shared by the panel and the notice. */
function UpdateStatus({ state, place }: { state: DesktopUpdateState; place: "panel" | "notice" }) {
  const t = useT(),
    { run, check, openDownload } = useUpdates();
  const [linkFailed, setLinkFailed] = useState(false);
  const version = state.version ?? "";
  const later = (
    <Button variant="ghost" onClick={() => run("dismiss")}>
      {t("appMenu.update.later")}
    </Button>
  );
  const download = (
    <Button
      variant={state.installable ? "secondary" : "primary"}
      onClick={() => {
        setLinkFailed(false);
        void openDownload().catch(() => setLinkFailed(true));
      }}
    >
      {t("appMenu.download")}
    </Button>
  );
  let message: string | undefined;
  let detail: string | undefined;
  let actions: React.ReactNode = null;
  switch (state.phase) {
    case "idle":
    case "checking":
      message = t("appMenu.checking");
      break;
    case "current":
      message = t("appMenu.update.current");
      break;
    case "available":
      message =
        place === "notice"
          ? t("appMenu.update.noticeTitle", { version })
          : t("appMenu.update.available", { version });
      if (state.reason) detail = t(`appMenu.update.reason.${state.reason}`);
      actions = (
        <>
          {state.installable ? (
            <Button onClick={() => run("download")}>{t("appMenu.update.update")}</Button>
          ) : (
            download
          )}
          {place === "notice" && later}
        </>
      );
      break;
    case "downloading":
      message = t("appMenu.update.downloading", { version, percent: state.percent ?? 0 });
      actions = (
        <Button variant="secondary" onClick={() => run("cancel")}>
          {t("appMenu.update.cancel")}
        </Button>
      );
      break;
    case "downloaded":
      message = t("appMenu.update.downloaded");
      detail = state.error ? t("appMenu.update.error.install") : t("appMenu.update.restartHint");
      actions = (
        <>
          <Button onClick={() => run("install")}>{t("appMenu.update.restart")}</Button>
          {later}
        </>
      );
      break;
    case "installing":
      message = t("appMenu.update.installing");
      break;
    case "error":
      message = t(`appMenu.update.error.${state.error ?? "network"}`);
      actions = (
        <>
          {state.error === "install" ? (
            download
          ) : (
            <Button
              variant="secondary"
              onClick={() => (state.error === "download" ? run("download") : check())}
            >
              {t("common.retry")}
            </Button>
          )}
          {place === "notice" && later}
        </>
      );
      break;
  }
  return (
    <>
      <p
        role="status"
        className={`${styles.status} ${place === "notice" ? styles.noticeTitle : ""}`}
      >
        <StatusDot state={phaseDot[state.phase]} />
        <span>{message}</span>
      </p>
      {state.phase === "downloading" && (
        <progress
          className={styles.progress}
          aria-label={message}
          value={state.percent ?? 0}
          max={100}
        />
      )}
      {detail && <p className={styles.note}>{detail}</p>}
      {state.notes && ["available", "downloading", "downloaded"].includes(state.phase) && (
        <UpdateNotes notes={state.notes} />
      )}
      {linkFailed && (
        <p role="alert" className={styles.error}>
          {t("workspace.failed")}
        </p>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
    </>
  );
}

/** Maintainers 2026-11-13: what the new version changes, as plain text lines in the UI language. */
function UpdateNotes({ notes }: { notes: NonNullable<DesktopUpdateState["notes"]> }) {
  const { t, language } = useSettings();
  const lines = language.startsWith("zh") ? notes.zh : notes.en;
  return (
    <section className={notesStyles.notes} aria-label={t("appMenu.update.notes")}>
      <h3>{t("appMenu.update.notes")}</h3>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

export function UpdatesPanel() {
  const t = useT(),
    { peer } = useRpc(),
    { state, bridgeFailed, fallback, check, holdNotice } = useUpdates();
  const checked = useRef(false);
  const [linkFailed, setLinkFailed] = useState(false);
  useEffect(() => holdNotice(), [holdNotice]);
  // Opening the panel is a manual check, once the bridge says which check applies.
  useEffect(() => {
    if (checked.current || (!state && !bridgeFailed)) return;
    checked.current = true;
    if (!state || !["downloading", "downloaded", "installing"].includes(state.phase)) check();
  }, [state, bridgeFailed, check]);
  const legacy = state?.reason === "dev" || (!state && bridgeFailed);
  const result = fallback.result;
  const idle = !state || ["idle", "current", "available", "error"].includes(state.phase);
  return (
    <>
      <div className={styles.brand}>
        <Logo size={64} />
      </div>
      {legacy ? (
        <>
          <p role="status">
            {fallback.busy
              ? t("appMenu.checking")
              : fallback.failed
                ? t("appMenu.updateUnavailable")
                : result
                  ? result.status === "available"
                    ? t("appMenu.update.available", { version: result.version })
                    : t(`appMenu.update.${result.status}`)
                  : null}
          </p>
          {state?.reason === "dev" && (
            <p className={styles.note}>{t("appMenu.update.reason.dev")}</p>
          )}
          {linkFailed && (
            <p role="alert" className={styles.error}>
              {t("workspace.failed")}
            </p>
          )}
        </>
      ) : (
        state && <UpdateStatus state={state} place="panel" />
      )}
      <p className={styles.note}>
        {t("appMenu.currentVersion", {
          version: state?.currentVersion ?? result?.currentVersion.split(":")[0] ?? "",
        })}
      </p>
      <p className={styles.note}>{t("appMenu.manualUpdates")}</p>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={legacy ? fallback.busy : !idle}
          onClick={() => check()}
        >
          {t("appMenu.update.recheck")}
        </Button>
        {legacy && result?.status === "available" && (
          <Button
            onClick={() => {
              setLinkFailed(false);
              void openWebsite(peer, result.url).catch(() => setLinkFailed(true));
            }}
          >
            {t("appMenu.download")}
          </Button>
        )}
      </div>
    </>
  );
}

/** The non-blocking corner prompt: found, downloading, ready to restart, or failed. */
export function UpdateNotice() {
  const t = useT(),
    { state, noticeHeld } = useUpdates();
  if (!state?.notice || noticeHeld || !state.version) return null;
  return (
    <section className={styles.notice} aria-label={t("appMenu.update.noticeLabel")}>
      <UpdateStatus state={state} place="notice" />
    </section>
  );
}
