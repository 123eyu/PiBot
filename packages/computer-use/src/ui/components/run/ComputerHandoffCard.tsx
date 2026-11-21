import { toolNameKey } from "@pibot/client-core";
import type { ComputerHandoffNotice } from "@pibot/computer-use-contract/full";
import type { TranslationKey } from "@pibot/i18n";
import { BotAvatar, useAction, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { memo, type ReactNode, useState } from "react";
import styles from "./computer-handoff.module.css";

type Translate = ReturnType<typeof useT>;
type Message = ComputerHandoffNotice["message"];
type Platform = ComputerHandoffNotice["platform"];

const PANES: Partial<Record<Message, "accessibility" | "screen">> = {
  accessibility: "accessibility",
  screen_recording: "screen",
  screen_recording_not_effective: "screen",
};
// Sentences that name platform places; the rest read the same everywhere.
const PER_PLATFORM: Record<Message, Partial<Record<Platform, TranslationKey>> | TranslationKey> = {
  accessibility: {
    darwin: "computerHandoff.say.accessibility.darwin",
    win32: "computerHandoff.say.accessibility.win32",
    linux: "computerHandoff.say.accessibility.linux",
  },
  screen_recording: {
    darwin: "computerHandoff.say.screen_recording.darwin",
    win32: "computerHandoff.say.screen_recording.win32",
    linux: "computerHandoff.say.screen_recording.linux",
  },
  // Only macOS has a grant that can look on yet not work; elsewhere it is the plain request.
  screen_recording_not_effective: {
    darwin: "computerHandoff.say.screen_recording_not_effective.darwin",
    win32: "computerHandoff.say.screen_recording.win32",
    linux: "computerHandoff.say.screen_recording.linux",
  },
  open_window: "computerHandoff.say.open_window",
  window_minimized: {
    darwin: "computerHandoff.say.window_minimized.darwin",
    win32: "computerHandoff.say.window_minimized.win32",
    linux: "computerHandoff.say.window_minimized.linux",
  },
  window_other_space: {
    darwin: "computerHandoff.say.window_other_space.darwin",
    win32: "computerHandoff.say.window_other_space.win32",
    linux: "computerHandoff.say.window_other_space.linux",
  },
  window_covered: "computerHandoff.say.window_covered",
  window_other: {
    darwin: "computerHandoff.say.window_other.darwin",
    win32: "computerHandoff.say.window_other.win32",
    linux: "computerHandoff.say.window_other.linux",
  },
  retry_limit: "computerHandoff.say.retry_limit",
};
const isPermission = (message: Message) => message in PANES;

/** The card's one sentence, chosen by brain and worded here per platform. */
export function handoffSentence(notice: ComputerHandoffNotice, botName: string, t: Translate) {
  const entry = PER_PLATFORM[notice.message];
  const key =
    typeof entry === "string" ? entry : (entry[notice.platform] ?? entry.darwin ?? entry.linux);
  return key
    ? t(key, { app: notice.app.name, name: botName, step: t(toolNameKey(notice.tool)) })
    : "";
}

/** "10 minutes" in chat, "24 hours" for a routine. */
function expiryText(notice: ComputerHandoffNotice, t: Translate) {
  const ms = Date.parse(notice.expiresAt) - Date.parse(notice.createdAt);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 120 && minutes % 60 === 0
    ? t("computerHandoff.expiresHours", { hours: minutes / 60 })
    : t("computerHandoff.expiresMinutes", { minutes });
}

const resultKeys = {
  continued: "computerHandoff.result.continued",
  declined: "computerHandoff.result.declined",
  timeout: "computerHandoff.result.timeout",
  cancelled: "computerHandoff.result.cancelled",
} as const;

/** Answers a card from the chat or the inbox; the other place updates from the notice event. */
export function useHandoffActions(notice: ComputerHandoffNotice) {
  const { peer } = useRpc();
  const task = useAction();
  const [settingsFailed, setSettingsFailed] = useState(false);
  const resolve = (action: "continue" | "decline") => {
    if (!peer) return;
    void task.run(
      () => peer.call("computer.handoff.resolve", { id: notice.id, action }),
      (error) =>
        error instanceof Error && error.message === "computer_handoff_closed"
          ? "computerHandoff.closed"
          : "computerHandoff.failed",
    );
  };
  const pane = notice.platform === "darwin" ? PANES[notice.message] : undefined;
  const openSettings = pane
    ? () => {
        if (!peer) return;
        setSettingsFailed(false);
        peer.call("computer.openSystemSettings", { pane }).catch(() => setSettingsFailed(true));
      }
    : undefined;
  return { task, resolve, openSettings, settingsFailed, connected: !!peer };
}

function Actions({
  notice,
  actions,
  extra,
}: {
  notice: ComputerHandoffNotice;
  actions: ReturnType<typeof useHandoffActions>;
  extra?: ReactNode;
}) {
  const t = useT();
  const { task, resolve, openSettings, connected } = actions;
  if (notice.status !== "pending") return null;
  return (
    <div className={styles.actions}>
      {openSettings && (
        <Button
          variant="secondary"
          className={styles.button}
          disabled={!connected}
          onClick={openSettings}
        >
          <Icon name="settings" size={14} />
          {t("computerHandoff.openSettings")}
        </Button>
      )}
      <Button
        className={`${styles.button} ${styles.go}`}
        loading={task.busy}
        disabled={!connected}
        onClick={() => resolve("continue")}
      >
        {t("computerHandoff.continue")}
      </Button>
      <Button
        variant="ghost"
        className={`${styles.button} ${styles.quiet}`}
        disabled={task.busy || !connected}
        onClick={() => resolve("decline")}
      >
        {t("computerHandoff.decline")}
      </Button>
      {extra}
    </div>
  );
}

function Errors({ actions }: { actions: ReturnType<typeof useHandoffActions> }) {
  const t = useT();
  if (!actions.task.error && !actions.settingsFailed) return null;
  return (
    <p className={styles.error} role="alert">
      {actions.task.error ? t(actions.task.error) : t("computerHandoff.settingsFailed")}
    </p>
  );
}

/** The one line a card turns into once it is answered. */
export function HandoffResult({ notice }: { notice: ComputerHandoffNotice }) {
  const t = useT();
  if (notice.status === "pending") return null;
  return (
    <p
      className={styles.result}
      role="status"
      data-tone={notice.status === "continued" ? "ok" : undefined}
    >
      <span className={styles.dot} data-tone={notice.status === "continued" ? "ok" : "muted"} />
      {t(resultKeys[notice.status])}
    </p>
  );
}

/**
 * The "come help" card in the chat, after the reply's tool steps. It sits
 * in the
 * reply column under the Bot's own avatar, so it draws none itself; the pill names the Bot.
 */
export const ComputerHandoffCard = memo(function ComputerHandoffCard({
  notice,
  botName,
}: {
  notice: ComputerHandoffNotice;
  botName: string;
}) {
  const t = useT();
  const actions = useHandoffActions(notice);
  return (
    <div className={styles.row}>
      {notice.status === "pending" ? (
        <section className={styles.card} aria-label={t("computerHandoff.title")}>
          <div className={styles.top}>
            <IconTile icon="hand" tone="pink" className={styles.chatTile} />
            <strong>{t("computerHandoff.title")}</strong>
            <span className={styles.pill}>{t("computerHandoff.waiting", { name: botName })}</span>
          </div>
          {!isPermission(notice.message) && (
            <span className={styles.app}>
              <IconTile icon="laptop" tone="pink" size="sm" className={styles.chatTile} />
              {notice.app.name}
            </span>
          )}
          <p className={styles.say}>{handoffSentence(notice, botName, t)}</p>
          <Actions notice={notice} actions={actions} />
          <Errors actions={actions} />
          <p className={styles.meta}>{expiryText(notice, t)}</p>
        </section>
      ) : (
        <HandoffResult notice={notice} />
      )}
    </div>
  );
});

/** The "come help" card in the inbox: the same card, compact. */
export function ComputerHandoffInbox({
  notice,
  meta,
  openChat,
  openBusy,
}: {
  notice: ComputerHandoffNotice;
  meta: string;
  openChat(): void;
  openBusy: boolean;
}) {
  const t = useT();
  const bot = useWorkspace().bots.find((item) => item.id === notice.botId);
  const name = bot?.name ?? t("workspace.botUnknown");
  const actions = useHandoffActions(notice);
  const go = (
    <Button
      variant="ghost"
      className={`${styles.button} ${styles.quiet}`}
      disabled={openBusy}
      onClick={openChat}
    >
      {t("computerHandoff.openChat")}
    </Button>
  );
  return (
    <article className={styles.inboxCard} aria-label={t("computerHandoff.title")}>
      <div className={styles.who}>
        <BotAvatar
          bot={bot}
          size={22}
          label={name}
          state={notice.status === "pending" ? "waiting" : "idle"}
        />
        <strong>{name}</strong>
        <small>{meta}</small>
      </div>
      <p className={`${styles.say} ${styles.compact}`}>{handoffSentence(notice, name, t)}</p>
      {notice.status === "pending" ? (
        <Actions notice={notice} actions={actions} extra={go} />
      ) : (
        <div className={styles.actions}>
          <HandoffResult notice={notice} />
          {go}
        </div>
      )}
      <Errors actions={actions} />
    </article>
  );
}
