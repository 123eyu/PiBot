// Keep the Windows disclosure and explicit consent with the existing YOLO confirmation.
import { isolationReasonText } from "@pibot/client-core";
import type { ConversationYolo } from "@pibot/protocol";
import { useAction, useNavigation, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { Overlay } from "../../workspace/Overlay.tsx";
import workspaceStyles from "../../workspace/workspace.module.css";
import styles from "./yolo.module.css";

export function YoloConfirmation({
  isolation,
  group,
  close,
  enable,
}: {
  isolation: ConversationYolo["isolation"];
  group: boolean;
  close(): void;
  enable(signal: AbortSignal, acknowledged: boolean): Promise<ConversationYolo | undefined>;
}) {
  const { t, settings } = useSettings();
  const action = useAction();
  const [acknowledged, setAcknowledged] = useState(false);
  const windows = window.pibot.platform === "win32";
  const consented = settings?.yoloUnisolatedCommands === true;
  const needsConsent = windows && !consented;
  return (
    <Overlay
      icon="bolt"
      tone="orange"
      title={t("yolo.confirmTitle")}
      close={close}
      busy={action.busy}
    >
      <div className={styles.confirm}>
        <p>{t("yolo.confirmIntro")}</p>
        {group && <p>{t("yolo.confirmGroup")}</p>}
        {!isolation.available && (!windows || isolation.reason !== "windows_unisolated") && (
          <p className={styles.risk} role="alert">
            {t("yolo.unisolated", {
              reason: isolationReasonText(isolation.reason, t) || t("yolo.unisolatedUnknown"),
            })}
          </p>
        )}
        <YoloScopes windows={windows} isolated={isolation.available} />
        {windows && (
          <WindowsYoloDisclosure
            consented={consented}
            ready={settings !== undefined}
            acknowledged={acknowledged}
            setAcknowledged={setAcknowledged}
            busy={action.busy}
            close={close}
          />
        )}
        <p className={styles.note}>
          {t(windows ? "yolo.nothingRemembered.windows" : "yolo.nothingRemembered")}
        </p>
      </div>
      <div className={workspaceStyles.actions}>
        <Button variant="secondary" disabled={action.busy} onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button
          className={styles.turnOn}
          loading={action.busy}
          disabled={windows && (!settings || (needsConsent && !acknowledged))}
          onClick={() =>
            void action
              .run(
                (signal) => enable(signal, needsConsent && acknowledged),
                () => "yolo.failed",
              )
              .then((value) => {
                if (value?.enabled) close();
              })
          }
        >
          {t("yolo.confirm")}
        </Button>
      </div>
      {action.error && (
        <p role="alert" className={workspaceStyles.error}>
          {t(action.error)}
        </p>
      )}
    </Overlay>
  );
}

function YoloScopes({ windows, isolated }: { windows: boolean; isolated: boolean }) {
  const { t } = useSettings();
  return (
    <div className={styles.scopes}>
      <section className={styles.scope} data-tone="ok">
        <h2>{t("yolo.skips")}</h2>
        <p>{t(windows ? "yolo.skipsList.windows" : "yolo.skipsList")}</p>
      </section>
      <section className={styles.scope} data-tone="danger">
        <h2>{t("yolo.keeps")}</h2>
        <p>{t(windows ? "yolo.keepsList.windows" : "yolo.keepsList")}</p>
        <p>
          {t(
            windows
              ? "yolo.readOnly.windows"
              : isolated
                ? "yolo.keepsSafety"
                : "yolo.keepsSafetyUnisolated",
          )}
        </p>
      </section>
    </div>
  );
}

function WindowsYoloDisclosure({
  consented,
  ready,
  acknowledged,
  setAcknowledged,
  busy,
  close,
}: {
  consented: boolean;
  ready: boolean;
  acknowledged: boolean;
  setAcknowledged(value: boolean): void;
  busy: boolean;
  close(): void;
}) {
  const { t } = useSettings();
  const { openSettings } = useNavigation();
  if (!ready) return <p role="status">{t("common.loading")}</p>;
  if (consented)
    return (
      <p className={styles.note}>
        {t("yolo.windowsReminder")}{" "}
        <button
          type="button"
          className={styles.consentLink}
          disabled={busy}
          onClick={() => {
            close();
            openSettings("permissions");
          }}
        >
          {t("yolo.windowsConsentSettings")}
        </button>
      </p>
    );
  return (
    <div className={styles.consentBanner}>
      <p>
        <strong>{t("yolo.windowsDisclosureTitle")}</strong> {t("yolo.windowsDisclosure")}
      </p>
      <label className={styles.consentCheck}>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
        />
        {t("yolo.windowsAcknowledge")}
      </label>
    </div>
  );
}
