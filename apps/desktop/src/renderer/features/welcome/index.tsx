import { hostPlatform, TaskStatus, useRpc, useSettings, useTask } from "@pibot/renderer-kit";
import { type FirstBotHandle, type FirstBotStatus, FirstBotStep } from "@pibot/teams/ui";
import { Avatar, Button, IconTile, Logo } from "@pibot/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import shared from "../../../../../../packages/renderer-kit/src/widgets/setup/setup.module.css";
import { StarterCards } from "../chat/screen/StarterCards.tsx";
import { AppearanceControls } from "../settings/appearance.tsx";
import { requirePeer } from "../settings/operations.ts";
import { ModelStep, type ModelStepHandle, type ModelStepStatus } from "./ModelStep.tsx";
import { readPermissionStep, welcomeSteps } from "./permission-step.ts";
import { SystemPermissionsStep } from "./SystemPermissionsStep.tsx";
import styles from "./welcome.module.css";

// Stable step IDs keep the Bot sub-pages intact when a platform omits system permissions.
const LAST = 4;

/*
 * Maintainers 2026-11-13: granting Screen Recording on macOS needs a restart, which used to send the
 * welcome back to its first page. Reaching the permissions step (or the last one) is remembered,
 * and a restart resumes there; earlier steps never resume, so no model or Bot is set up twice.
 * Local storage is enough: it lives in this data directory and only skips pages already passed.
 */
const RESUME_KEY = "pibot.welcome.resume";
const RESUMABLE = new Set([3, LAST]);
function resumedStep() {
  try {
    const value = Number(localStorage.getItem(RESUME_KEY));
    return RESUMABLE.has(value) ? value : 0;
  } catch {
    return 0; // Storage blocked: starting from the first page is the old, safe behaviour.
  }
}
function rememberStep(step: number) {
  try {
    if (RESUMABLE.has(step)) localStorage.setItem(RESUME_KEY, String(step));
  } catch {
    // Not remembering only means a restart starts from the first page again.
  }
}
function forgetStep() {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    // Nothing to clean up when storage is blocked.
  }
}

export function WelcomeFlow({ onDone: finishWelcome }: { onDone(): void }) {
  const { peer } = useRpc();
  const { t, update } = useSettings();
  const task = useTask();
  const [step, setStep] = useState(resumedStep);
  useEffect(() => rememberStep(step), [step]);
  const onDone = () => {
    forgetStep();
    finishWelcome();
  };
  const [omitPermissions, setOmitPermissions] = useState(hostPlatform() === "win32");
  const steps = welcomeSteps(omitPermissions);
  const permissionRead = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retired peer must not navigate from its late status reply.
  useLayoutEffect(() => () => permissionRead.current?.abort(), [peer]);
  const [permissionsReady, setPermissionsReady] = useState(false);
  const afterBot = () => {
    void task.run(async () => {
      permissionRead.current?.abort();
      const request = new AbortController();
      permissionRead.current = request;
      const skip = await readPermissionStep(
        hostPlatform(),
        (signal) =>
          requirePeer(peer).call("computer.permissions", undefined, { signal, timeoutMs: 5_000 }),
        request.signal,
      );
      if (request.signal.aborted) return;
      setOmitPermissions(skip);
      setStep(skip ? LAST : 3);
    });
  };
  const modelStep = useRef<ModelStepHandle>(null);
  const [modelStatus, setModelStatus] = useState<ModelStepStatus>({ busy: false, ready: false });
  const botStep = useRef<FirstBotHandle>(null);
  // 上一步 from a later step remounts the Bot step; keep the role picked there (second-Mac test).
  const [botRole, setBotRole] = useState<string>();
  const [botStatus, setBotStatus] = useState<FirstBotStatus>({
    stage: "pick",
    busy: false,
    ready: false,
  });
  const body = useRef<HTMLDivElement>(null);
  // The body scroll persists across steps otherwise, so a new step could open mid-page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a step or sub-page change triggers it.
  useLayoutEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [step, botStatus.stage]);
  const stepBusy = (step === 1 && modelStatus.busy) || (step === 2 && botStatus.busy);
  const next = () =>
    step === 1
      ? modelStep.current?.next()
      : step === 2
        ? botStep.current?.next()
        : setStep((current) => current + 1);
  const back = () => {
    if (step === 1) modelStep.current?.back();
    else if (step !== 2 || !botStep.current?.back())
      setStep(steps[Math.max(0, steps.indexOf(step) - 1)] ?? 0);
  };
  return (
    <main className={styles.root}>
      <div ref={body} className={styles.body}>
        <div className={`${styles.content} ${step === 0 || step === LAST ? styles.center : ""}`}>
          <TaskStatus task={task} />
          {step === 0 && (
            <>
              <Logo size={104} className={styles.logo} />
              <div>
                <h1>{t("welcome.title")}</h1>
                <p className={shared.note}>{t("welcome.subtitle")}</p>
              </div>
              <div className={styles.values}>
                {(
                  [
                    ["team", "users", "violet"],
                    ["local", "home", "teal"],
                    ["approval", "shield", "orange"],
                  ] as const
                ).map(([value, icon, tone]) => (
                  <div key={value} className={styles.value} data-tone={tone}>
                    <IconTile icon={icon} tone={tone} size="lg" />
                    <strong>{t(`welcome.value.${value}.title`)}</strong>
                    <p className={shared.note}>{t(`welcome.value.${value}.body`)}</p>
                  </div>
                ))}
              </div>
              <AppearanceControls
                disabled={task.busy || !peer}
                onChange={(patch) =>
                  void task.run(async () => {
                    requirePeer(peer);
                    await update(patch);
                  })
                }
              />
            </>
          )}
          {step === 1 && (
            <>
              <div>
                <h1>{t("welcome.model.title")}</h1>
                <p className={shared.note}>{t("welcome.model.subtitle")}</p>
              </div>
              <ModelStep
                ref={modelStep}
                onStatus={setModelStatus}
                onBack={() => setStep(0)}
                onContinue={() => setStep(2)}
              />
            </>
          )}
          {/* A first run brings at most one Bot besides Pi; groups wait for later. */}
          {step === 2 && (
            <FirstBotStep
              ref={botStep}
              initialRole={botRole}
              onRole={setBotRole}
              onStatus={setBotStatus}
              onFinish={afterBot}
            />
          )}
          {step === 3 && (
            <>
              <h1>{t("welcome.computer.title")}</h1>
              <p className={shared.note}>{t("welcome.computer.body")}</p>
              <SystemPermissionsStep onReady={setPermissionsReady} />
            </>
          )}
          {step === LAST && (
            <>
              <span className={styles.glow}>
                <Avatar
                  shape="blob"
                  color="violet"
                  eyes="marks"
                  size={112}
                  label={t("sidebar.piLabel")}
                />
              </span>
              <div>
                <h1>{t("welcome.pi.title")}</h1>
                <p className={shared.note}>{t("welcome.pi.subtitle")}</p>
              </div>
              {/* The hello reads as Pi's first chat message: a small Pi beside a Bot bubble. */}
              <div className={styles.helloRow}>
                <span aria-hidden="true" className={styles.helloAvatar}>
                  <Avatar
                    shape="blob"
                    color="violet"
                    eyes="marks"
                    size={30}
                    label={t("sidebar.piLabel")}
                  />
                </span>
                <p className={styles.hello}>{t("welcome.pi.hello")}</p>
              </div>
              <StarterCards
                items={(["plan", "write", "learn", "brainstorm"] as const).map((idea) =>
                  t(`suggestion.${idea}`),
                )}
                onPick={onDone}
              />
            </>
          )}
        </div>
      </div>
      <footer className={styles.footer}>
        <ol
          className={styles.progress}
          aria-label={t("welcome.progress", { step: steps.indexOf(step) + 1, total: steps.length })}
        >
          {steps.map((dot) => (
            <li key={dot} className={styles.dot} aria-current={dot === step ? "step" : undefined} />
          ))}
        </ol>
        {step > 0 && (
          <Button variant="ghost" disabled={task.busy || stepBusy} onClick={back}>
            {t("common.back")}
          </Button>
        )}
        {step === 2 && (
          <Button variant="ghost" disabled={task.busy || botStatus.busy} onClick={afterBot}>
            {t("builtin.firstBot.skip")}
          </Button>
        )}
        {step < LAST ? (
          <Button
            loading={task.busy || stepBusy}
            disabled={
              !peer || (step === 1 && !modelStatus.ready) || (step === 2 && !botStatus.ready)
            }
            onClick={next}
          >
            {t(
              step === 0
                ? "common.getStarted"
                : step === 3 && !permissionsReady
                  ? "welcome.computer.later"
                  : "common.continue",
            )}
          </Button>
        ) : (
          <Button onClick={onDone}>{t("welcome.pi.chat")}</Button>
        )}
      </footer>
    </main>
  );
}
