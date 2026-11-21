import type { Bot, BotHooksConfig } from "@pibot/protocol";
import { botPanelStyles as styles, useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, IconTile, Switch } from "@pibot/ui";
import { useEffect, useState } from "react";
import hookStyles from "./hooks.module.css";

/** Maintainers 2026-11-13: switches save as flipped, the command saves on blur / Enter; no Save button. */
export function ProfileHooks({ bot }: { bot: Bot }) {
  const t = useT();
  const { peer } = useRpc();
  const action = useAction();
  const [saved, setSaved] = useState(false);
  // Autosave confirmation: a brief tag, not a line that stays.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);
  const [snapshot, setSnapshot] = useState<{
    peer: typeof peer;
    botId: string;
    config?: BotHooksConfig;
    failed?: boolean;
  }>();
  // The last config the brain confirmed; a blur that changed nothing does not save again.
  const [stored, setStored] = useState<BotHooksConfig>();
  const current = snapshot?.peer === peer && snapshot?.botId === bot.id ? snapshot : undefined;
  const config = current?.config;
  const failed = current?.failed;
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly requests a fresh RPC read.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    let version = 0;
    const load = () => {
      const request = ++version;
      void peer.call("botHooks.get", { botId: bot.id }, { signal: controller.signal }).then(
        (value) => {
          if (!controller.signal.aborted && request === version) {
            setSnapshot({ peer, botId: bot.id, config: value.config });
            setStored(value.config);
          }
        },
        () => {
          if (!controller.signal.aborted && request === version)
            setSnapshot({ peer, botId: bot.id, failed: true });
        },
      );
    };
    load();
    const off = peer.on("botHooks.changed", (event) => {
      if (event.botId === bot.id) load();
    });
    return () => {
      controller.abort();
      off();
    };
  }, [peer, bot.id, revision]);
  if (failed)
    return (
      <section className={styles.section}>
        <h2>{t("hooks.title")}</h2>
        <div className={styles.card}>
          <div className={styles.cardRow}>
            <IconTile icon="warning" tone="red" size="lg" />
            <span className={styles.rowText}>
              <strong role="alert">{t("hooks.loadFailed")}</strong>
            </span>
            <Button variant="pill" onClick={() => setRevision((value) => value + 1)}>
              {t("common.retry")}
            </Button>
          </div>
        </div>
      </section>
    );
  if (!config)
    return (
      <section className={styles.section}>
        <h2>{t("hooks.title")}</h2>
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      </section>
    );
  const locked = action.busy || bot.archivedAt !== null;
  // Formatting needs a command; until one is typed the switch stays a local draft.
  const incomplete = config.formatOnWrite && !config.formatCommand.trim();
  const persist = (next: BotHooksConfig) => {
    setSnapshot({ peer, botId: bot.id, config: next });
    if (next.formatOnWrite && !next.formatCommand.trim()) return;
    if (
      stored &&
      stored.formatOnWrite === next.formatOnWrite &&
      stored.formatCommand === next.formatCommand &&
      stored.notifyOnCompletion === next.notifyOnCompletion
    )
      return;
    void action.run(
      async (signal) => {
        if (!peer) return;
        const value = await peer.call("botHooks.set", { botId: bot.id, config: next }, { signal });
        if (!signal.aborted) {
          setSnapshot({ peer, botId: bot.id, config: value.config });
          setStored(value.config);
          setSaved(true);
        }
      },
      () => "hooks.failed",
    );
  };
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2>{t("hooks.title")}</h2>
        {saved && (
          <Chip tone="ok" role="status" className={hookStyles.saved}>
            {t("workspace.saved")}
          </Chip>
        )}
      </div>
      <div className={styles.card}>
        {bot.category !== "image" && (
          <>
            <div className={styles.cardRow}>
              <IconTile icon="edit" tone="blue" size="lg" />
              <span className={styles.rowText}>
                <strong>{t("hooks.format")}</strong>
              </span>
              <Switch
                label={t("hooks.format")}
                checked={config.formatOnWrite}
                disabled={locked}
                onCheckedChange={(formatOnWrite) => persist({ ...config, formatOnWrite })}
              />
            </div>
            <label className={hookStyles.field}>
              <span>{t("hooks.command")}</span>
              <input
                className={hookStyles.command}
                value={config.formatCommand}
                maxLength={1000}
                disabled={locked}
                aria-invalid={incomplete || undefined}
                onChange={(event) =>
                  setSnapshot({
                    peer,
                    botId: bot.id,
                    config: { ...config, formatCommand: event.currentTarget.value },
                  })
                }
                onBlur={() => persist(config)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <small>{incomplete ? t("hooks.needCommand") : t("hooks.note")}</small>
            </label>
          </>
        )}
        <div className={styles.cardRow}>
          <IconTile icon="message" tone="amber" size="lg" />
          <span className={styles.rowText}>
            <strong>{t("hooks.notify")}</strong>
            <small>{t("hooks.notifyNote")}</small>
          </span>
          <Switch
            label={t("hooks.notify")}
            checked={config.notifyOnCompletion}
            disabled={locked}
            onCheckedChange={(notifyOnCompletion) => persist({ ...config, notifyOnCompletion })}
          />
        </div>
      </div>
      {action.error && (
        <p className={styles.error} role="alert">
          {t(action.error)}
        </p>
      )}
    </section>
  );
}
