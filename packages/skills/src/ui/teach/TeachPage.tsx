import { BotAvatar, type Peer, useNavigation, useT, useWorkspace } from "@pibot/renderer-kit";
import type { Bot } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { useSkillRoutineNavigation } from "../shell/ports.tsx";
import { skillRoutineInitial } from "../skills/presentation.ts";
import { DraftEditor } from "./DraftEditor.tsx";
import { RecordingView, ResumePrompt, ReviewStage, StartForm } from "./RecordStage.tsx";
import styles from "./teach.module.css";
import { type Outcome, type Stage, useTeach } from "./use-teach.ts";

const STAGES = ["record", "review", "saved"] as const;
/** A saved lesson shows every step done until "teach another" starts the next one. */
const stepOf = (stage: Stage, outcome: Outcome | undefined) =>
  outcome?.kind === "saved" ? STAGES.length : stage === "draft" ? 1 : 0;

/** How the last lesson ended, above the "teach another" button (start stage). */
function Ended({
  teach,
  bot,
  outcome,
}: {
  teach: ReturnType<typeof useTeach>;
  bot: Bot | undefined;
  outcome: Outcome;
}) {
  const t = useT();
  const { navigate, openBotPanel } = useNavigation();
  const { openRoutines } = useSkillRoutineNavigation();
  if (!bot) return null;
  const saved = outcome.kind === "saved" ? outcome : undefined;
  return (
    <div className={styles.saved} role="status">
      <BotAvatar bot={bot} size={72} state={saved ? "done" : "idle"} label={bot.name} />
      <h2 className={styles.savedTitle}>
        {saved
          ? t("teach.savedTitle", { name: bot.name, skill: saved.skill.name })
          : t("teach.discardedTitle")}
      </h2>
      <p className={styles.note}>
        {!saved
          ? t("teach.discardedNote", { name: bot.name })
          : saved.routine
            ? t("teach.savedRoutine")
            : t("teach.savedChat", { skill: saved.skill.name })}
      </p>
      <div className={styles.actions}>
        {saved && (
          <Button
            variant="secondary"
            onClick={() => {
              // The Bot's newest topic is now the trial run; show the skill beside a fresh
              // draft instead of reopening that run.
              navigate({ name: "chat", botId: bot.id, draftId: crypto.randomUUID() });
              openBotPanel(bot.id, "memory", true, saved.skill.id);
            }}
          >
            {t("teach.openSkill")}
          </Button>
        )}
        {saved?.routine && (
          <Button
            variant="secondary"
            onClick={() =>
              openRoutines("new", bot.id, skillRoutineInitial(t, saved.skill.name, saved.params))
            }
          >
            {t("teach.makeRoutine")}
          </Button>
        )}
        <Button onClick={teach.again}>{t("teach.again")}</Button>
      </div>
    </div>
  );
}

/**
 * "Teach it once": record in the Bot browser → review and draft →
 * save. A main-area page, entered from the profile panel's memory tab.
 */
export function TeachPage({ botId, peer }: { botId: string; peer: Peer }) {
  const t = useT();
  const { navigate } = useNavigation();
  const { bots } = useWorkspace();
  const bot = bots.find((b) => b.id === botId);
  const name = bot?.name ?? "";
  const teach = useTeach(botId, peer);
  const { stage, outcome } = teach.snap;
  const current = stepOf(stage, outcome);
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <BotAvatar
          bot={bot}
          size={32}
          label={name}
          state={stage === "recording" ? "thinking" : outcome?.kind === "saved" ? "done" : "idle"}
        />
        <div className={styles.title}>
          <h1>{t("teach.title", { name })}</h1>
          <span className={styles.note}>{t("teach.subtitle")}</span>
        </div>
        <ol className={styles.stepper} aria-label={t("teach.progress")}>
          {STAGES.map((id, i) => (
            <li
              key={id}
              className={i === current ? styles.stepOn : i < current ? styles.stepDone : undefined}
              aria-current={i === current ? "step" : undefined}
            >
              {i < current ? "✓" : i + 1} {t(`teach.stage.${id}`)}
            </li>
          ))}
        </ol>
        <Button variant="ghost" onClick={() => navigate({ name: "chat", botId })}>
          {t("teach.close")}
        </Button>
      </header>
      {teach.error && (
        <p className={styles.error} role="alert">
          {t(teach.error, { name })}
        </p>
      )}
      {stage === "recording" ? (
        <RecordingView teach={teach} peer={peer} botId={botId} botName={name} />
      ) : (
        <div className={styles.scroll}>
          <div className={styles.content}>
            {stage === "start" &&
              (outcome ? (
                <Ended teach={teach} bot={bot} outcome={outcome} />
              ) : teach.busy === "check" ? (
                <p className={styles.card} role="status">
                  {t("teach.checking")}
                </p>
              ) : (
                <StartForm teach={teach} botName={name} />
              ))}
            {stage === "resume" && <ResumePrompt teach={teach} botName={name} />}
            {stage === "review" && <ReviewStage teach={teach} peer={peer} botName={name} />}
            {stage === "draft" && <DraftEditor teach={teach} bot={bot} />}
          </div>
        </div>
      )}
    </main>
  );
}

/** Entry in the profile panel's memory tab. */
export function TeachEntry({ bot }: { bot: Bot }) {
  const t = useT();
  const { navigate } = useNavigation();
  if (bot.category === "image") return null;
  return (
    <section className={styles.entry}>
      <h2 className={styles.label}>{t("teach.entry")}</h2>
      <p className={styles.note}>{t("teach.entryNote", { name: bot.name })}</p>
      <Button variant="secondary" onClick={() => navigate({ name: "teach", botId: bot.id })}>
        {t("teach.entry")}
      </Button>
    </section>
  );
}
