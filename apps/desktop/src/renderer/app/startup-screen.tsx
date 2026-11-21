import { useEffect, useState } from "react";
import {
  type StartupLabelKey,
  type StartupLabelTables,
  startupTranslator,
} from "../../shared/startup-labels.ts";
import type { StartupSnapshot } from "../../shared/startup-snapshot.ts";
import chatStyles from "../features/chat/chat.module.css";
import { CachedChat } from "./startup-chat.tsx";
import styles from "./startup-display.module.css";
import { CachedSidebar } from "./startup-sidebar.tsx";
import { useStartupTheme } from "./startup-theme.ts";

// The first frame. Nothing here may import @pibot/i18n or @pibot/protocol at runtime: either
// pulls the full translation tables and the shared schema chunk into the first paint. Text comes
// from the label tables the GUI main process read from @pibot/i18n.

type Language = "zh" | "en";
/** Same rule as @pibot/i18n resolveLanguage, kept local for the reason above. */
function resolveLanguage(setting: "system" | Language, systemLocale: string): Language {
  return setting === "system"
    ? systemLocale.toLowerCase().startsWith("zh")
      ? "zh"
      : "en"
    : setting;
}

/** Startup phases are identifiers; group them into the few steps a user can act on. */
const phaseSteps: ReadonlyArray<readonly [RegExp, StartupLabelKey]> = [
  [
    /^(data_dir|db_open|migrations|kernel_storage|session_tail_recovery|attachments_recover|background_recover|durable_recovery)$/,
    "startup.step.recovery",
  ],
  [/^network$/, "startup.step.network"],
  [/^(register|start)\./, "startup.step.capabilities"],
];
const stepKey = (phase: string): StartupLabelKey =>
  phaseSteps.find(([pattern]) => pattern.test(phase))?.[1] ?? "startup.step.services";
/** The four steps in the order they happen; the dots show how far startup has come. */
const stepOrder: readonly StartupLabelKey[] = [
  "startup.step.recovery",
  "startup.step.network",
  "startup.step.capabilities",
  "startup.step.services",
];
/** Done / current / waiting dots for the step progress; decorative, the text says the step. */
function StepDots({
  phase,
  done = false,
  t,
}: {
  phase: string | null;
  done?: boolean;
  t: (key: StartupLabelKey) => string;
}) {
  const current = done ? stepOrder.length : phase ? stepOrder.indexOf(stepKey(phase)) : -1;
  return (
    <span className={styles.steps} aria-hidden="true">
      {stepOrder.map((key, index) => (
        <i
          key={key}
          title={t(key)}
          data-state={index < current ? "done" : index === current ? "current" : undefined}
        />
      ))}
    </span>
  );
}
/** The owner sends a phase with each progress beat; older owners send nothing, so this is null. */
function useStartupPhase() {
  const [phase, setPhase] = useState<string | null>(null);
  useEffect(() => {
    return window.pibotStartup?.onProgress((value) => setPhase(value.phase));
  }, []);
  return phase;
}

// The cached screen can mount twice (before and after the background answers); time it once.
let cachedTimingSent = false;
/**
 * A read-only copy of the live chat screen laid out with the live CSS modules, so swapping it for
 * the real UI keeps every box in place. `inert` blocks interaction without the greyed look that
 * `disabled` would add to controls the live screen shows enabled.
 */
export function CachedStartupScreen({
  snapshot,
  labels,
  connected = false,
  systemLocale,
}: {
  snapshot: StartupSnapshot;
  labels: StartupLabelTables;
  connected?: boolean;
  systemLocale?: string;
}) {
  const theme = useStartupTheme(snapshot.theme);
  const language = resolveLanguage(snapshot.language, systemLocale ?? navigator.language);
  const t = startupTranslator(labels[language]);
  const phase = useStartupPhase();
  useEffect(() => {
    if (cachedTimingSent) return;
    const frame = setTimeout(() => {
      cachedTimingSent = true;
      window.pibotStartup?.timing({
        method: "cached_screen",
        durationMs: performance.now(),
        ok: true,
      });
    });
    return () => clearTimeout(frame);
  }, []);
  return (
    <section className={styles.cached} style={theme} aria-label={t("startup.cached")}>
      <div className={`${chatStyles.shell} ${styles.shell}`} inert>
        <CachedSidebar snapshot={snapshot} language={language} t={t} />
        <CachedChat conversation={snapshot.conversation} language={language} t={t} />
      </div>
      <div className={styles.banner} data-connected={connected || undefined} role="status">
        <span className={styles.pulse} aria-hidden="true" />
        <span className={styles.bannerText}>
          {connected
            ? t("startup.refreshing")
            : phase
              ? t("startup.connectingPhase", { step: t(stepKey(phase)) })
              : t("startup.connecting")}{" "}
          <small>{t("startup.readonly")}</small>
        </span>
        <StepDots phase={phase} done={connected} t={t} />
      </div>
    </section>
  );
}

/** Without label tables (main did not answer in time) the page stays blank rather than guess. */
export function StartupPlaceholder({
  systemLocale,
  labels,
}: {
  systemLocale: string;
  labels: StartupLabelTables | null;
}) {
  const theme = useStartupTheme("system");
  const phase = useStartupPhase();
  const t = labels ? startupTranslator(labels[resolveLanguage("system", systemLocale)]) : null;
  return (
    <main className={styles.starting} style={theme}>
      <div className={styles.startingCard}>
        <span className={styles.mark} aria-hidden="true" />
        <p role="status">
          {t &&
            (phase ? t("startup.startingPhase", { step: t(stepKey(phase)) }) : t("brain.starting"))}
        </p>
        {t && <StepDots phase={phase} t={t} />}
      </div>
    </main>
  );
}
