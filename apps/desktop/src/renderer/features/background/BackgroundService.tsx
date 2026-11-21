import { DesktopBackgroundMethods, type DesktopBackgroundResults } from "@pibot/protocol";
import {
  SettingsLine,
  SettingsRow,
  SettingsSection,
  type Tone,
  useSettings,
  waitRpc,
} from "@pibot/renderer-kit";
import { routineError, useRoutineAction } from "@pibot/routines/ui";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";

function backgroundBridge(): Window["pibot"]["background"] | undefined {
  const bridge = window.pibot.background;
  return bridge && typeof bridge.state === "function" && typeof bridge.restart === "function"
    ? bridge
    : undefined;
}

type ServiceState = DesktopBackgroundResults["background.state"]["state"];
const TONE: Record<ServiceState, Tone> = {
  starting: "warn",
  ready: "ok",
  restarting: "warn",
  failed: "danger",
  stopped: "danger",
};

/**
 * The brain host on this computer: one sentence of state with a coloured dot and a restart
 * button; uptime and restart counters are left to the exported logs.
 */
export function BackgroundService() {
  const { t } = useSettings();
  const [state, setState] = useState<DesktopBackgroundResults["background.state"]>();
  const [error, setError] = useState<ReturnType<typeof routineError>>();
  const [confirm, setConfirm] = useState(false);
  const [requested, setRequested] = useState(false);
  const [revision, setRevision] = useState(0);
  const action = useRoutineAction(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision is the explicit retry/restart refresh trigger for the local main bridge.
  useEffect(() => {
    const owner = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(undefined);
    setError(undefined);
    const read = async () => {
      const bridge = backgroundBridge();
      if (!bridge) {
        setError("routines.unavailable");
        return;
      }
      try {
        const result = DesktopBackgroundMethods["background.state"].result.parse(
          await waitRpc(
            () => bridge.state(),
            AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]),
          ),
        );
        if (!owner.signal.aborted) {
          setState(result);
          setError(undefined);
        }
      } catch (e) {
        if (!owner.signal.aborted) setError(routineError(e));
      }
      if (!owner.signal.aborted) timer = setTimeout(() => void read(), 5000);
    };
    void read();
    return () => {
      owner.abort();
      clearTimeout(timer);
    };
  }, [revision]);
  const restart = () => {
    const bridge = backgroundBridge();
    if (!bridge) return;
    void action
      .run(async () =>
        DesktopBackgroundMethods["background.restart"].result.parse(await bridge.restart()),
      )
      .then((result) => {
        if (result) {
          setRequested(true);
          setConfirm(false);
          setRevision((n) => n + 1);
        }
      });
  };
  return (
    <SettingsSection title={t("computer.title")}>
      {state && !confirm && (
        <SettingsRow
          icon="settings"
          tone="teal"
          dot={TONE[state.state]}
          label={t(`computer.state.${state.state}`)}
        >
          <Button variant="secondary" disabled={action.disabled} onClick={() => setConfirm(true)}>
            {t("computer.restart")}
          </Button>
        </SettingsRow>
      )}
      {confirm && (
        <SettingsLine
          role="alert"
          tone="warn"
          action={
            <>
              <Button disabled={action.disabled} onClick={restart}>
                {t("computer.restart")}
              </Button>
              <Button variant="secondary" onClick={() => setConfirm(false)}>
                {t("common.cancel")}
              </Button>
            </>
          }
        >
          {t("computer.confirmRestart")}
        </SettingsLine>
      )}
      {!state && !error && <SettingsLine role="status">{t("common.loading")}</SettingsLine>}
      {error && (
        <SettingsLine
          role="alert"
          tone="danger"
          dot="danger"
          action={
            <Button variant="secondary" onClick={() => setRevision((n) => n + 1)}>
              {t("common.retry")}
            </Button>
          }
        >
          {t(error)}
        </SettingsLine>
      )}
      {requested && state?.state !== "ready" && (
        <SettingsLine role="status">{t("computer.restartRequested")}</SettingsLine>
      )}
      {action.error && (
        <SettingsLine role="alert" tone="danger">
          {t(action.error)}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}
