import type { Bot } from "@pibot/protocol";
import {
  botPanelStyles as styles,
  useAction,
  useComboboxText,
  useRpc,
  useT,
} from "@pibot/renderer-kit";
import { Combobox, IconTile, Switch } from "@pibot/ui";
import { useEffect, useState } from "react";
import type { BotUpdate } from "./use-bot-editor.ts";

const AUTO = "";

/**
 * 「代码审查」: who reviews this Bot's code (empty = Pi Bot recommends one) and
 * whether a turn that changed files asks for a review by itself. Turning that on with no
 * built-in code reviewer around creates 小审 and makes it the default, as the role list would.
 */
export function ProfileReview({
  bot,
  save,
  busy,
}: {
  bot: Bot;
  save(patch: BotUpdate): Promise<boolean>;
  busy: boolean;
}) {
  const t = useT();
  const text = useComboboxText();
  const { peer } = useRpc();
  const action = useAction();
  const [bots, setBots] = useState<Bot[]>();
  const [revision, setRevision] = useState(0);
  const [created, setCreated] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads after creating 小审
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    peer.call("bots.list", { limit: 200 }, { signal: abort.signal, timeoutMs: 15_000 }).then(
      (list) => !abort.signal.aborted && setBots(list),
      // Without the list the selector only offers "recommend"; the switch still works.
      () => !abort.signal.aborted && setBots([]),
    );
    return () => abort.abort();
  }, [peer, bot.id, revision]);
  if (bot.category === "image") return null;
  const live = (bots ?? []).filter(
    (item) => !item.archivedAt && item.category === "chat" && item.modelId,
  );
  const options = [
    { value: AUTO, label: t("panel.review.recommend") },
    ...live.map((item) => ({
      value: item.id,
      label: item.id === bot.id ? t("panel.review.self", { name: item.name }) : item.name,
      keywords: [item.modelId ?? ""],
    })),
  ];
  const value =
    bot.reviewBotId && live.some((item) => item.id === bot.reviewBotId) ? bot.reviewBotId : AUTO;
  const setAuto = (enabled: boolean) =>
    void action.run(
      async () => {
        setCreated(undefined);
        if (!enabled || live.some((item) => item.role?.id === "code-reviewer")) {
          if (!(await save({ autoReview: enabled }))) throw new Error("save failed");
          return;
        }
        if (!peer) throw new Error("brain unavailable");
        const made = await peer.call(
          "builtin.createBot",
          { roleId: "code-reviewer" },
          { timeoutMs: 60_000 },
        );
        if (!(await save({ autoReview: true, reviewBotId: made.bot.id })))
          throw new Error("save failed");
        setCreated(made.bot.name);
        setRevision((n) => n + 1);
      },
      () => "panel.review.failed",
    );
  return (
    <section className={styles.section}>
      <h2>{t("panel.review.title")}</h2>
      <div className={styles.row}>
        <IconTile icon="search" tone="orange" size="lg" />
        <span>{t("panel.review.reviewer")}</span>
        <Combobox
          {...text}
          variant="pill"
          hideLabel
          label={t("panel.review.reviewer")}
          placeholder={t("panel.review.recommend")}
          options={options}
          value={value}
          disabled={busy || action.busy || !bots}
          onValueChange={(next) =>
            void action.run(
              async () => {
                setCreated(undefined);
                if (!(await save({ reviewBotId: next === AUTO ? null : next })))
                  throw new Error("save failed");
              },
              () => "panel.review.failed",
            )
          }
        />
      </div>
      <p className={styles.note}>{t("panel.review.reviewerNote", { name: bot.name })}</p>
      <div className={styles.row}>
        <IconTile icon="check" tone="green" size="lg" />
        <span>{t("panel.review.auto.title")}</span>
        <Switch
          label={t("panel.review.auto.title")}
          checked={!!bot.autoReview}
          disabled={busy || action.busy}
          onCheckedChange={setAuto}
        />
      </div>
      <p className={styles.note}>{t("panel.review.auto.note")}</p>
      {created && (
        <p role="status" className={styles.note}>
          {t("panel.review.created", { name: created })}
        </p>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </section>
  );
}
